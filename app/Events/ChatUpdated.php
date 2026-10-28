<?php
namespace App\Events;
use Illuminate\Broadcasting\PrivateChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
class ChatUpdated implements ShouldBroadcastNow
{
    public function __construct(public string $recipient, public array $data) {}
    public function broadcastOn(): array { return [new PrivateChannel('anonymous.'.$this->recipient)]; }
    public function broadcastAs(): string { return 'chat.updated'; }
    public function broadcastWith(): array { return $this->data; }
}
