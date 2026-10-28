<?php

namespace Tests\Feature;

use App\Events\ChatUpdated;
use App\Services\MatchmakingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class VideoChatTest extends TestCase
{
    private MatchmakingService $chat;

    protected function setUp(): void
    {
        parent::setUp();
        config(['chat.store' => 'array']);
        Cache::store('array')->flush();
        Event::fake([ChatUpdated::class]);
        $this->chat = app(MatchmakingService::class);
    }

    private function act(string $id, string $action, array $input = []): array
    {
        return $this->chat->act($id, 'tab-'.$id, $action, $input);
    }

    private function pair(string $mode = 'video'): string
    {
        $this->act('a', 'start', ['mode' => $mode]);
        return $this->act('b', 'start', ['mode' => $mode])['room'];
    }

    private function signal(string $room, string $kind = 'ready', ?array $payload = null): array
    {
        return ['room' => $room, 'kind' => $kind, 'instance' => (string) Str::uuid(), 'sequence' => 1, 'negotiation' => (string) Str::uuid(), 'payload' => $payload];
    }

    private function assertForbidden(callable $operation, int $status = 403): void
    {
        try {
            $operation();
            $this->fail('The unauthorized signaling request was accepted.');
        } catch (HttpException $exception) {
            $this->assertSame($status, $exception->getStatusCode());
        }
    }

    public function test_video_queue_is_separate_and_roles_are_stable_across_heartbeats(): void
    {
        $this->act('text-user', 'start');
        $waiting = $this->act('a', 'start', ['mode' => 'video']);
        $this->assertSame('searching', $waiting['status']);
        $this->assertSame('video', $waiting['mode']);
        $connected = $this->act('b', 'start', ['mode' => 'video']);
        $this->assertSame('connected', $connected['status']);
        $this->assertTrue($connected['initiator']);
        $this->assertFalse($this->act('a', 'heartbeat')['initiator']);
        $this->assertTrue($this->act('b', 'heartbeat')['initiator']);
        $this->assertSame('searching', $this->act('text-user', 'heartbeat')['status']);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'b' && $e->data['type'] === 'matched' && $e->data['mode'] === 'video' && $e->data['initiator']);
        $next = $this->act('a', 'next');
        $this->assertSame('video', $next['mode']);
        $this->assertSame('searching', $next['status']);
        $this->assertFalse($next['initiator']);
    }

    public function test_legacy_waiting_users_still_match_as_text(): void
    {
        $this->act('a', 'start');
        $state = Cache::store('array')->get('chat:state');
        unset($state['users']['a']['mode']);
        Cache::store('array')->put('chat:state', $state);
        $result = $this->act('b', 'start');
        $this->assertSame('connected', $result['status']);
        $this->assertSame('text', $result['mode']);
    }

    public function test_signals_go_only_to_the_peer_and_sensitive_payloads_are_never_stored(): void
    {
        $room = $this->pair();
        $payload = ['sdp' => "v=0\r\nprivate-sdp-sentinel"];
        $signal = $this->signal($room, 'offer', $payload);
        $result = $this->act('b', 'signal', $signal);
        $this->assertSame($room, $result['room']);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'a' && $e->data['type'] === 'signal' && $e->data['payload'] === $payload && $e->data['instance'] === $signal['instance'] && $e->data['negotiation'] === $signal['negotiation']);
        Event::assertNotDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'b' && $e->data['type'] === 'signal');
        $state = json_encode(Cache::store('array')->get('chat:state'));
        $this->assertStringNotContainsString('private-sdp-sentinel', $state);
        $this->assertStringNotContainsString($signal['instance'], $state);
        $this->assertStringNotContainsString($signal['negotiation'], $state);
    }

    public function test_signals_require_current_video_room_membership_and_tab_ownership(): void
    {
        $room = $this->pair();
        $signal = $this->signal($room);
        $this->assertForbidden(fn () => $this->act('intruder', 'signal', $signal));
        $this->assertForbidden(fn () => $this->chat->act('a', 'another-tab', 'signal', $signal), 409);
        $this->act('a', 'next');
        $this->assertForbidden(fn () => $this->act('b', 'signal', $signal));
        Event::assertNotDispatched(ChatUpdated::class, fn ($e) => $e->data['type'] === 'signal');
    }

    public function test_replayed_and_retired_connection_signals_are_rejected(): void
    {
        $room = $this->pair();
        $first = $this->signal($room);
        $this->act('a', 'signal', $first);
        $this->assertForbidden(fn () => $this->act('a', 'signal', $first), 409);
        $this->act('a', 'signal', [...$first, 'sequence' => 2]);
        $this->act('a', 'signal', $this->signal($room));
        $this->assertForbidden(fn () => $this->act('a', 'signal', [...$first, 'sequence' => 3]), 409);
        Event::assertDispatched(ChatUpdated::class, 5); // Two match events and three accepted signals.
    }

    public function test_text_rooms_cannot_use_video_signaling_and_offer_roles_are_enforced(): void
    {
        $room = $this->pair('text');
        $this->assertForbidden(fn () => $this->act('a', 'signal', $this->signal($room)));
        $this->act('a', 'stop');
        $room = $this->pair('video');
        $this->assertForbidden(fn () => $this->act('a', 'signal', $this->signal($room, 'offer', ['sdp' => 'v=0'])));
        $this->assertForbidden(fn () => $this->act('b', 'signal', $this->signal($room, 'answer', ['sdp' => 'v=0'])));
    }

    public function test_http_signaling_validates_shapes_lengths_and_serialized_bytes(): void
    {
        $base = $this->signal((string) Str::uuid(), 'offer', ['sdp' => 'v=0']);
        $base['tab'] = (string) Str::uuid();
        foreach ([
            [...$base, 'kind' => 'unknown'],
            [...$base, 'instance' => 'not-a-uuid'],
            [...$base, 'payload' => ['sdp' => 'v=0', 'recipient' => 'forged']],
            [...$base, 'payload' => ['sdp' => 'v=0'.str_repeat('x', 60000)]],
            [...$base, 'payload' => ['sdp' => 'v=0'.str_repeat('❤', 20000)]],
            [...$base, 'kind' => 'ice', 'payload' => ['candidate' => str_repeat('x', 4097)]],
            [...$base, 'kind' => 'ice', 'payload' => ['candidate' => 'candidate:1', 'sdpMLineIndex' => -1]],
            [...$base, 'kind' => 'ready', 'payload' => ['sdp' => 'v=0']],
        ] as $invalid) {
            $this->postJson('/chat/signal', $invalid)->assertUnprocessable();
        }
        $this->postJson('/chat/start', ['tab' => (string) Str::uuid(), 'mode' => 'unrecognized'])->assertUnprocessable();
    }

    public function test_http_signal_response_contains_state_without_echoing_the_sdp(): void
    {
        $a = (string) Str::uuid();
        $b = (string) Str::uuid();
        $tab = (string) Str::uuid();
        $this->chat->act($a, (string) Str::uuid(), 'start', ['mode' => 'video']);
        $room = $this->chat->act($b, $tab, 'start', ['mode' => 'video'])['room'];
        $sdp = "v=0\r\nsecret-sdp\r\n";
        $this->withSession(['anonymous_id' => $b])->postJson('/chat/signal', [
            ...$this->signal($room, 'offer', ['sdp' => $sdp]), 'tab' => $tab,
        ])->assertOk()->assertJsonPath('mode', 'video')->assertJsonPath('initiator', true)->assertJsonMissingPath('payload')->assertJsonMissingPath('tab');
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->data['type'] === 'signal' && $e->data['payload']['sdp'] === $sdp);
    }

    public function test_turn_rest_secret_is_replaced_by_short_lived_browser_credentials(): void
    {
        config(['webrtc.turn_urls' => ['turn:relay.example.test:3478'], 'webrtc.turn_secret' => 'server-only-turn-secret']);
        $response = $this->get('/');
        $response->assertOk();
        $page = $response->viewData('page');
        $rtc = $page['props']['webrtc'];
        $this->assertTrue($rtc['turnConfigured']);
        $this->assertArrayNotHasKey('credential', $rtc['iceServers'][0]);
        $id = (string) Str::uuid();
        $tab = (string) Str::uuid();
        $this->chat->act('peer', 'peer-tab', 'start', ['mode' => 'video']);
        $room = $this->chat->act($id, $tab, 'start', ['mode' => 'video'])['room'];
        $ice = $this->withSession(['anonymous_id' => $id])->postJson('/chat/ice', ['room' => $room, 'tab' => $tab]);
        $ice->assertOk()->assertHeader('Cache-Control', 'no-store, private');
        $turn = $ice->json('iceServers')[array_key_last($ice->json('iceServers'))];
        $this->assertGreaterThan(now()->timestamp, (int) explode(':', $turn['username'])[0]);
        $this->assertSame(base64_encode(hash_hmac('sha1', $turn['username'], 'server-only-turn-secret', true)), $turn['credential']);
        $this->assertStringNotContainsString('server-only-turn-secret', $response->getContent());
    }
}
