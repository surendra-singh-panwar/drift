<?php
namespace Tests\Feature;

use App\Events\ChatUpdated;
use App\Services\MatchmakingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Tests\TestCase;

class IceConfigurationTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();
        config(['chat.store' => 'array', 'webrtc.turn_urls' => ['turn:relay.example.test:3478'],
            'webrtc.turn_secret' => 'server-only-secret', 'webrtc.turn_ttl' => 600]);
        Event::fake([ChatUpdated::class]);
        Cache::store('array')->flush();
    }

    private function participant(string $mode = 'video'): array
    {
        $id = (string) Str::uuid(); $tab = (string) Str::uuid();
        $service = app(MatchmakingService::class);
        $service->act('peer', 'peer-tab', 'start', ['mode' => $mode]);
        $state = $service->act($id, $tab, 'start', ['mode' => $mode]);
        return [$id, $tab, $state];
    }

    public function test_credentials_require_current_active_video_room_and_tab(): void
    {
        [$id, $tab, $state] = $this->participant();
        $this->withSession(['anonymous_id' => $id]);
        $body = ['room' => $state['room'], 'tab' => $tab];
        $this->postJson('/chat/ice', $body)->assertOk()->assertJsonPath('expiresAt', now()->timestamp + 600);
        $this->postJson('/chat/ice', [...$body, 'tab' => (string) Str::uuid()])->assertForbidden();
        $this->postJson('/chat/ice', [...$body, 'room' => (string) Str::uuid()])->assertForbidden();
        $this->withSession(['anonymous_id' => (string) Str::uuid()])->postJson('/chat/ice', $body)->assertForbidden();
        $this->withSession(['anonymous_id' => $id]);
        $this->travel(46)->seconds();
        $this->postJson('/chat/ice', $body)->assertForbidden();
    }

    public function test_group_credentials_require_current_membership_and_stop_revokes_access(): void
    {
        [$id, $tab, $state] = $this->participant('group');
        $this->withSession(['anonymous_id' => $id]);
        $body = ['room' => $state['room'], 'tab' => $tab];
        $this->postJson('/chat/ice', $body)->assertForbidden();
        $body['membership'] = $state['epochs'][$id];
        $this->postJson('/chat/ice', $body)->assertOk();
        app(MatchmakingService::class)->act($id, $tab, 'stop');
        $this->postJson('/chat/ice', $body)->assertForbidden();
    }

    public function test_text_users_do_not_receive_credentials_and_homepage_contains_no_turn_password(): void
    {
        config(['webrtc.turn_secret' => null, 'webrtc.turn_username' => 'legacy-user', 'webrtc.turn_password' => 'legacy-password']);
        [$id, $tab, $state] = $this->participant('text');
        $this->withSession(['anonymous_id' => $id])->postJson('/chat/ice', ['tab' => $tab, 'room' => $state['room']])->assertForbidden();
        $response = $this->get('/')->assertOk();
        $this->assertStringNotContainsString('legacy-password', $response->getContent());
        $this->assertStringNotContainsString('legacy-user', $response->getContent());
    }

    public function test_stun_only_local_development_and_authenticated_restart_signal(): void
    {
        config(['webrtc.turn_urls' => []]);
        [$id, $tab, $state] = $this->participant();
        $this->withSession(['anonymous_id' => $id])->postJson('/chat/ice', ['tab' => $tab, 'room' => $state['room']])
            ->assertOk()->assertJsonPath('turnConfigured', false)->assertJsonPath('expiresAt', null);
        $this->postJson('/chat/signal', ['tab' => $tab, 'room' => $state['room'], 'kind' => 'restart',
            'instance' => (string) Str::uuid(), 'negotiation' => (string) Str::uuid(), 'sequence' => 1])->assertOk();
        Event::assertDispatched(ChatUpdated::class, fn ($event) => ($event->data['kind'] ?? null) === 'restart');
    }

    public function test_credentials_rotate_and_endpoint_has_its_own_rate_limit(): void
    {
        [$id, $tab, $state] = $this->participant();
        $body = ['tab' => $tab, 'room' => $state['room']];
        $this->withSession(['anonymous_id' => $id]);
        $first = $this->postJson('/chat/ice', $body)->assertOk()->json();
        $second = $this->postJson('/chat/ice', $body)->assertOk()->json();
        $this->assertNotSame($first['iceServers'][1]['username'], $second['iceServers'][1]['username']);
        $this->assertStringNotContainsString('server-only-secret', json_encode($second));
        for ($i = 0; $i < 10; $i++) $this->postJson('/chat/ice', $body)->assertOk();
        $this->postJson('/chat/ice', $body)->assertTooManyRequests();
        $this->postJson('/chat/heartbeat', ['tab' => $tab])->assertOk();
    }
}
