<?php
namespace Tests\Feature;

use App\Events\ChatUpdated;
use App\Services\MatchmakingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class GroupChatTest extends TestCase
{
    private MatchmakingService $chat;
    protected function setUp(): void
    {
        parent::setUp();
        config(['chat.store' => 'array']);
        Cache::store('array')->flush();
        Storage::fake('local');
        Event::fake([ChatUpdated::class]);
        $this->chat = app(MatchmakingService::class);
    }
    private function act($id, $action = 'start', $data = []): array
    {
        $user = Cache::store('array')->get('chat:state')['users'][$id] ?? [];
        $epochs = Cache::store('array')->get('chat:state')['rooms'][$user['room'] ?? '']['epochs'] ?? [];
        return $this->chat->act($id, 'tab-'.$id, $action, ['mode' => 'group', 'membership' => $epochs[$id] ?? null, ...$data]);
    }
    private function signal($from, $to, $kind = 'ready'): array
    {
        $state = $this->act($from, 'heartbeat');
        return ['room' => $state['room'], 'to' => $to, 'kind' => $kind, 'instance' => (string) Str::uuid(), 'negotiation' => (string) Str::uuid(), 'sequence' => 1,
            'membership' => $state['epochs'][$from], 'targetMembership' => $state['epochs'][$to], 'payload' => in_array($kind, ['offer', 'answer']) ? ['sdp' => "v=0\r\n"] : null];
    }
    private function denied(callable $operation, int $status = 403): void
    {
        try { $operation(); $this->fail('Unauthorized operation accepted.'); }
        catch (HttpException $e) { $this->assertSame($status, $e->getStatusCode()); }
    }
    public function test_groups_fill_eight_places_and_ninth_gets_another_room(): void
    {
        $room = $this->act('a')['room'];
        foreach (['b', 'c', 'd', 'e', 'f', 'g', 'h'] as $index => $id) {
            $result = $this->act($id);
            $this->assertSame($room, $result['room']);
            $this->assertCount($index + 2, $result['members']);
        }
        $this->assertNotSame($room, $this->act('i')['room']);
        $this->assertCount(8, $this->act('a', 'heartbeat')['members']);
        $this->assertSame($room, $this->act('a')['room']);
        $this->denied(fn () => $this->chat->act('a', 'other-tab', 'start', ['mode' => 'group']), 409);
    }
    public function test_join_and_leave_preserve_other_members_and_empty_rooms_are_deleted(): void
    {
        $first = $this->act('a'); $room = $first['room'];
        $this->act('b'); $before = $this->act('c');
        $this->act('b', 'stop');
        $after = $this->act('a', 'heartbeat');
        $this->assertSame($room, $after['room']);
        $this->assertSame(['a', 'c'], $after['members']);
        $this->assertSame($before['epochs']['a'], $after['epochs']['a']);
        $this->assertSame($before['epochs']['c'], $after['epochs']['c']);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'c' && $e->data['type'] === 'group-members' && $e->data['change'] === 'left');
        $this->act('a', 'stop'); $this->act('c', 'stop');
        $this->assertArrayNotHasKey($room, Cache::store('array')->get('chat:state')['rooms']);
    }
    public function test_next_prefers_an_alternative_and_does_not_end_the_previous_group(): void
    {
        foreach (['a','b','c','d','e','f','g','h','i'] as $id) $this->act($id);
        $previous = $this->act('a', 'heartbeat')['room'];
        $alternative = $this->act('i', 'heartbeat')['room'];
        $next = $this->act('a', 'next');
        $this->assertSame($alternative, $next['room']);
        $this->assertSame($previous, $this->act('b', 'heartbeat')['room']);
        $this->assertCount(7, $this->act('b', 'heartbeat')['members']);
        for ($i = 0; $i < 8; $i++) $this->act('a', 'next');
        $rooms = Cache::store('array')->get('chat:state')['rooms'];
        $this->assertCount(1, array_filter($rooms, fn ($r) => in_array('a', $r['members'], true)));
        foreach ($rooms as $data) $this->assertLessThanOrEqual(8, count($data['members']));
    }
    public function test_signaling_is_targeted_roles_are_deterministic_and_replays_rejected(): void
    {
        foreach (['a', 'b', 'c'] as $id) $this->act($id);
        $signal = $this->signal('b', 'a', 'offer');
        $this->act('b', 'signal', $signal);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'a' && $e->data['type'] === 'signal' && $e->data['from'] === 'b');
        Event::assertNotDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'c' && $e->data['type'] === 'signal');
        $this->denied(fn () => $this->act('b', 'signal', $signal), 409);
        $this->denied(fn () => $this->act('a', 'signal', $this->signal('a', 'b', 'offer')));
        $this->denied(fn () => $this->act('c', 'signal', [...$this->signal('c', 'a'), 'to' => 'outsider']));
        $this->denied(fn () => $this->act('outsider', 'signal', $signal));
    }
    public function test_left_and_rejoined_members_cannot_replay_old_ice_or_messages(): void
    {
        $this->act('a'); $this->act('b');
        $signal = $this->signal('b', 'a', 'ice'); $signal['payload'] = ['candidate' => 'candidate:stale'];
        $this->act('b', 'stop'); $this->act('b');
        $this->denied(fn () => $this->act('b', 'signal', $signal));
        $this->denied(fn () => $this->act('b', 'message', ['room' => $signal['room'], 'membership' => $signal['membership'], 'id' => (string) Str::uuid(), 'text' => 'old']));
        $this->act('a', 'next');
        $this->denied(fn () => $this->act('b', 'signal', $signal));
    }
    public function test_group_messages_fan_out_once_without_retaining_content(): void
    {
        foreach (['a','b','c','d','e','f','g','h'] as $id) $state = $this->act($id);
        $message = ['room' => $state['room'], 'id' => (string) Str::uuid(), 'text' => 'group-private-message'];
        $this->act('a', 'message', $message); $this->act('a', 'message', $message);
        foreach (['b','c','d','e','f','g','h'] as $id) Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === $id && $e->data['type'] === 'message' && $e->data['from'] === 'a');
        $this->assertCount(7, Event::dispatched(ChatUpdated::class, fn ($e) => $e->data['type'] === 'message'));
        $this->assertStringNotContainsString($message['text'], json_encode(Cache::store('array')->get('chat:state')));
    }
    public function test_expiry_removes_only_the_abandoned_member(): void
    {
        foreach (['a','b','c'] as $id) $this->act($id);
        $this->travel(30)->seconds(); $this->act('b', 'heartbeat'); $this->act('c', 'heartbeat');
        $this->travel(16)->seconds();
        $result = $this->act('b', 'heartbeat');
        $this->assertSame(['b','c'], $result['members']);
        $this->assertSame('connected', $result['status']);
    }
    public function test_reports_persist_without_automatic_removal_and_moderation_requires_confirmation(): void
    {
        $this->act('a'); $room = $this->act('b')['room'];
        $report = $this->act('a', 'report', ['room' => $room, 'target' => 'b', 'reason' => 'Abusive behavior']);
        Storage::disk('local')->assertExists('chat-reports/'.$report['report'].'.json');
        $this->assertCount(2, $this->act('a', 'heartbeat')['members']);
        $this->artisan('chat:review-report', ['report' => $report['report'], '--remove' => true])->assertExitCode(1);
        $this->assertSame($room, $this->act('b', 'heartbeat')['room']);
        $this->artisan('chat:review-report', ['report' => $report['report'], '--remove' => true, '--confirm' => true])->assertExitCode(0);
        $this->assertSame('idle', $this->act('b', 'heartbeat')['status']);
        $this->assertNotSame($room, $this->act('b')['room']);
        $this->denied(fn () => $this->act('a', 'report', ['room' => $room, 'target' => 'outsider', 'reason' => 'Forged report']));
    }
    public function test_multiple_expirations_broadcast_only_the_final_membership_snapshot(): void
    {
        foreach (['a','b','c','d'] as $id) $this->act($id);
        $this->travel(30)->seconds(); $this->act('b', 'heartbeat'); $this->act('d', 'heartbeat');
        Event::fake([ChatUpdated::class]);
        $this->travel(16)->seconds();
        $result = $this->act('b', 'heartbeat');
        $this->assertSame(['b','d'], $result['members']);
        Event::assertDispatched(ChatUpdated::class, 2);
        foreach (Event::dispatched(ChatUpdated::class) as [$event]) {
            $this->assertSame(['b','d'], $event->data['members']);
            $this->assertSame(['b','d'], array_keys($event->data['epochs']));
        }
    }
    public function test_block_moves_only_the_blocker_and_prevents_matching_either_direction(): void
    {
        foreach (['a','b','c'] as $id) $state = $this->act($id);
        $blocked = $this->act('a', 'block', ['room' => $state['room'], 'target' => 'b']);
        $this->assertNotSame($state['room'], $blocked['room']);
        $this->assertSame(['b','c'], $this->act('b', 'heartbeat')['members']);
        $this->assertNotSame($blocked['room'], $this->act('b', 'next')['room']);
    }

    public function test_moderator_uses_the_reports_original_redis_namespace(): void
    {
        if (!getenv('RUN_REDIS_TESTS')) $this->markTestSkipped('Requires RUN_REDIS_TESTS=1.');
        $saved = ['chat.store' => config('chat.store'), 'cache.prefix' => config('cache.prefix')];
        config(['chat.store' => 'redis', 'cache.prefix' => 'drift-report-test-'.Str::uuid().':']);
        Cache::forgetDriver('redis');
        $cache = Cache::store('redis');
        try {
            $this->chat->act('a', 'tab-a', 'start', ['mode' => 'group']);
            $joined = $this->chat->act('b', 'tab-b', 'start', ['mode' => 'group']);
            $report = $this->chat->act('a', 'tab-a', 'report', ['room' => $joined['room'], 'target' => 'b', 'membership' => $joined['epochs']['a'], 'reason' => 'Moderator namespace test']);
            config($saved); Cache::forgetDriver('redis');
            $this->artisan('chat:review-report', ['report' => $report['report'], '--remove' => true, '--confirm' => true])->assertExitCode(0);
            $this->assertSame('idle', $cache->get('chat:state')['users']['b']['status']);
            $this->assertSame($saved['cache.prefix'], config('cache.prefix'));
            $this->assertSame($saved['chat.store'], config('chat.store'));
        } finally {
            $cache->forget('chat:state');
            config($saved); Cache::forgetDriver('redis');
        }
    }

    public function test_http_ice_batches_are_bounded_validated_and_targeted(): void
    {
        $a = (string) Str::uuid(); $b = (string) Str::uuid(); $tab = (string) Str::uuid();
        $this->chat->act($a, $tab, 'start', ['mode' => 'group']);
        $state = $this->chat->act($b, (string) Str::uuid(), 'start', ['mode' => 'group']);
        $packet = ['tab' => $tab, 'room' => $state['room'], 'to' => $b, 'membership' => $state['epochs'][$a], 'targetMembership' => $state['epochs'][$b],
            'kind' => 'ice-batch', 'instance' => (string) Str::uuid(), 'negotiation' => (string) Str::uuid(), 'sequence' => 1,
            'payload' => ['candidates' => [['candidate' => 'candidate:1', 'sdpMid' => '0', 'sdpMLineIndex' => 0]]]];
        $this->withSession(['anonymous_id' => $a])->postJson('/chat/signal', $packet)->assertOk();
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === $b && $e->data['type'] === 'signal' && $e->data['kind'] === 'ice-batch');
        foreach ([[], array_fill(0, 11, ['candidate' => 'c']), [['candidate' => str_repeat('x', 4097)]], [['candidate' => 'c', 'forged' => 'value']], [['sdpMid' => '0']]] as $invalid) {
            $this->postJson('/chat/signal', [...$packet, 'payload' => ['candidates' => $invalid]])->assertUnprocessable();
        }
    }
}
