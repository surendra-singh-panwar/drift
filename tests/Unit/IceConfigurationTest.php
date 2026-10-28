<?php

namespace Tests\Unit;

use App\Services\IceConfiguration;
use InvalidArgumentException;
use Tests\TestCase;

class IceConfigurationTest extends TestCase
{
    public function test_multiple_stun_and_turn_urls_support_udp_tcp_and_tls(): void
    {
        config([
            'webrtc.stun_urls' => ['stun:stun.example.test:3478', 'stun:backup.example.test:19302'],
            'webrtc.turn_urls' => [
                'turn:relay.example.test:3478?transport=udp',
                'turn:relay.example.test:3478?transport=tcp',
                'turns:relay.example.test:5349?transport=tcp',
            ],
            'webrtc.turn_secret' => 'server-only-secret',
            'webrtc.turn_username' => null,
            'webrtc.turn_password' => null,
            'webrtc.turn_ttl' => 1800,
            'webrtc.ice_transport_policy' => 'all',
        ]);

        $configuration = app(IceConfiguration::class)->make(true);

        $this->assertSame(['stun:stun.example.test:3478', 'stun:backup.example.test:19302'], $configuration['iceServers'][0]['urls']);
        $this->assertSame([
            'turn:relay.example.test:3478?transport=udp',
            'turn:relay.example.test:3478?transport=tcp',
            'turns:relay.example.test:5349?transport=tcp',
        ], $configuration['iceServers'][1]['urls']);
        $this->assertNotSame('server-only-secret', $configuration['iceServers'][1]['credential']);
        $this->assertSame('all', $configuration['iceTransportPolicy']);
    }

    public function test_turn_urls_without_credentials_are_not_sent_as_usable_turn_servers(): void
    {
        config([
            'webrtc.stun_urls' => ['stun:stun.example.test:3478'],
            'webrtc.turn_urls' => ['turn:relay.example.test:3478?transport=udp'],
            'webrtc.turn_secret' => null,
            'webrtc.turn_username' => null,
            'webrtc.turn_password' => null,
        ]);

        $configuration = app(IceConfiguration::class)->make(true);

        $this->assertFalse($configuration['turnConfigured']);
        $this->assertCount(1, $configuration['iceServers']);
    }

    public function test_invalid_ice_url_is_rejected(): void
    {
        config(['webrtc.stun_urls' => ['https://stun.example.test'], 'webrtc.turn_urls' => []]);
        $this->expectException(InvalidArgumentException::class);
        app(IceConfiguration::class)->make();
    }

    public function test_invalid_turn_transport_is_rejected(): void
    {
        config(['webrtc.stun_urls' => [], 'webrtc.turn_urls' => ['turn:relay.example.test:3478?transport=sctp']]);
        $this->expectException(InvalidArgumentException::class);
        app(IceConfiguration::class)->make();
    }

    public function test_static_turn_credentials_must_be_configured_as_a_pair(): void
    {
        config([
            'webrtc.stun_urls' => [],
            'webrtc.turn_urls' => ['turn:relay.example.test:3478?transport=tcp'],
            'webrtc.turn_secret' => null,
            'webrtc.turn_username' => 'restricted-user',
            'webrtc.turn_password' => null,
        ]);
        $this->expectException(InvalidArgumentException::class);
        app(IceConfiguration::class)->make(true);
    }
}
