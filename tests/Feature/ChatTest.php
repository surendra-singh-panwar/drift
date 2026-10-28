<?php
namespace Tests\Feature;
use App\Events\ChatUpdated;
use App\Services\MatchmakingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Str;
use Symfony\Component\HttpKernel\Exception\HttpException;
use Tests\TestCase;

class ChatTest extends TestCase
{
    private MatchmakingService $chat;
    protected function setUp(): void
    {
        parent::setUp();
        config(['chat.store' => 'array', 'broadcasting.default' => 'reverb', 'broadcasting.connections.reverb.key' => 'test', 'broadcasting.connections.reverb.secret' => 'test', 'broadcasting.connections.reverb.app_id' => 'test']);
        Cache::store('array')->flush();
        Event::fake([ChatUpdated::class]);
        $this->chat = app(MatchmakingService::class);
    }
    private function act($id, $action, $input = []) { return $this->chat->act($id, 'tab-'.$id, $action, $input); }
    private function pair(): string { $this->act('a', 'start'); return $this->act('b', 'start')['room']; }
    public function test_waiting_and_no_self_match(): void { $this->assertSame('searching', $this->act('a', 'start')['status']); $this->assertNull($this->act('a', 'start')['room']); }
    public function test_two_strangers_match_and_duplicate_start_is_idempotent(): void
    {
        $room = $this->pair();
        $this->assertSame($room, $this->act('a', 'start')['room']);
        $this->assertSame('searching', $this->act('c', 'start')['status']);
        Event::assertDispatched(ChatUpdated::class, 2);
    }
    public function test_messages_deliver_once_and_are_never_stored(): void
    {
        $room = $this->pair();
        $message = ['room' => $room, 'id' => (string) Str::uuid(), 'text' => '<script>hello</script>'];
        $this->act('a', 'message', $message); $this->act('a', 'message', $message);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'b' && $e->data['type'] === 'message' && $e->data['text'] === $message['text']);
        Event::assertDispatched(ChatUpdated::class, 3);
        $this->assertStringNotContainsString($message['text'], json_encode(Cache::store('array')->get('chat:state')));
    }
    public function test_third_user_cannot_send_to_chat(): void
    {
        $room = $this->pair(); $this->expectException(HttpException::class);
        $this->act('c', 'message', ['room' => $room, 'id' => (string) Str::uuid(), 'text' => 'intrude']);
    }
    public function test_next_ends_previous_room_and_searches(): void
    {
        $room = $this->pair();
        $this->assertSame('searching', $this->act('a', 'next')['status']);
        $this->assertSame('idle', $this->act('b', 'heartbeat')['status']);
        $this->assertArrayNotHasKey($room, Cache::store('array')->get('chat:state')['rooms']);
    }
    public function test_stop_removes_waiting_and_connected_state(): void
    {
        $this->act('a', 'start'); $this->assertSame('idle', $this->act('a', 'stop')['status']);
        $this->pair(); $this->act('a', 'stop'); $this->assertNull($this->act('b', 'heartbeat')['room']);
    }
    public function test_disconnection_expires_after_heartbeat_lease(): void
    {
        $this->pair(); $this->travel(30)->seconds(); $this->act('b', 'heartbeat'); $this->travel(16)->seconds();
        $this->assertSame('idle', $this->act('b', 'heartbeat')['status']);
        Event::assertDispatched(ChatUpdated::class, fn ($e) => $e->recipient === 'b' && $e->data['type'] === 'ended');
    }
    public function test_duplicate_tabs_are_rejected(): void
    {
        $this->act('a', 'start'); $this->expectException(HttpException::class); $this->chat->act('a', 'other-tab', 'start');
    }
    public function test_same_owner_resumes_connected_room_and_other_owner_waits_for_expiry(): void
    {
        $room = $this->pair();
        $this->assertSame($room, $this->act('a', 'heartbeat')['room']);
        try {
            $this->chat->act('a', 'new-tab', 'heartbeat');
            $this->fail('A second owner must not acquire a live session.');
        } catch (HttpException $e) {
            $this->assertSame(409, $e->getStatusCode());
        }
        $this->travel(30)->seconds();
        $this->act('b', 'heartbeat');
        $this->travel(16)->seconds();
        $this->assertSame('idle', $this->chat->act('a', 'new-tab', 'heartbeat')['status']);
        $this->assertSame('idle', $this->act('b', 'heartbeat')['status']);
        $this->assertArrayNotHasKey($room, Cache::store('array')->get('chat:state')['rooms']);
    }
    public function test_stale_room_cannot_receive_messages(): void
    {
        $room = $this->pair(); $this->act('a', 'next'); $this->expectException(HttpException::class);
        $this->act('a', 'message', ['room' => $room, 'id' => 'm', 'text' => 'stale']);
    }
    public function test_absolute_session_lifetime_expires_even_with_heartbeats(): void
    {
        config(['chat.lease' => 5000]); $this->pair(); $this->travel(3601)->seconds();
        $this->assertSame('idle', $this->act('a', 'heartbeat')['status']);
    }
    public function test_private_channel_authorization_uses_session_identity(): void
    {
        $id = (string) Str::uuid();
        $this->withSession(['anonymous_id' => $id])->postJson('/broadcasting/auth', ['socket_id' => '123.456', 'channel_name' => 'private-anonymous.'.$id])->assertOk()->assertJsonStructure(['auth']);
        $this->withSession(['anonymous_id' => $id])->postJson('/broadcasting/auth', ['socket_id' => '123.456', 'channel_name' => 'private-anonymous.'.Str::uuid()])->assertForbidden();
    }
    public function test_http_validation_and_server_owned_identity(): void
    {
        $this->postJson('/chat/start', ['tab' => (string) Str::uuid(), 'id' => 'forged'])->assertOk()->assertJsonPath('status', 'searching');
        $this->postJson('/chat/message', ['tab' => 'invalid', 'text' => str_repeat('x', 2001)])->assertUnprocessable();
    }
    public function test_redis_outage_returns_service_unavailable_without_connection_details(): void
    {
        $this->mock(MatchmakingService::class, function ($mock) {
            $mock->shouldReceive('act')->once()->andThrow(new \Predis\Connection\Resource\Exception\StreamInitException('Internal Redis endpoint and connection details'));
        });
        $this->postJson('/chat/heartbeat', ['tab' => (string) Str::uuid()])
            ->assertStatus(503)
            ->assertExactJson(['message' => 'Chat service is temporarily unavailable. Please try again shortly.']);
    }
}
