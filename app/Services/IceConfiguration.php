<?php
namespace App\Services;

use InvalidArgumentException;
use Illuminate\Support\Str;

class IceConfiguration
{
    public function make(bool $includeCredentials = false): array
    {
        $servers = [];
        $stunUrls = $this->validateUrls(config('webrtc.stun_urls', []), false);
        if ($stunUrls) $servers[] = ['urls' => $stunUrls];
        $urls = $this->validateUrls(config('webrtc.turn_urls', []), true);
        $secret = config('webrtc.turn_secret');
        $username = config('webrtc.turn_username');
        $password = config('webrtc.turn_password');
        if ((bool) $username !== (bool) $password) {
            throw new InvalidArgumentException('Both TURN_USERNAME and TURN_PASSWORD must be configured together.');
        }
        $configured = (bool) ($urls && ($secret || ($username && $password)));
        $expires = null;
        if ($includeCredentials && $configured) {
            $credential = $password;
            if ($secret) {
                $expires = now()->timestamp + config('webrtc.turn_ttl');
                $username = $expires.':'.Str::uuid();
                $credential = base64_encode(hash_hmac('sha1', $username, $secret, true));
            }
            $servers[] = ['urls' => $urls, 'username' => $username, 'credential' => $credential];
        }
        return ['iceServers' => $servers, 'iceTransportPolicy' => config('webrtc.ice_transport_policy'),
            'turnConfigured' => $configured, 'expiresAt' => $expires, 'recovery' => [
                'disconnectGraceMs' => config('webrtc.disconnect_grace_ms'),
                'connectTimeoutMs' => config('webrtc.connect_timeout_ms'),
                'groupConnectTimeoutMs' => config('webrtc.group_connect_timeout_ms'),
                'attemptTimeoutMs' => config('webrtc.recovery_timeout_ms'),
                'maxAttempts' => config('webrtc.recovery_attempts'),
                'backoffMs' => config('webrtc.recovery_backoff_ms'),
            ]];
    }

    private function validateUrls(array $urls, bool $turn): array
    {
        foreach ($urls as $url) {
            if (!is_string($url) || !preg_match('/\A(stun|turn|turns):([^?#]+)(?:\?([^#]*))?\z/i', $url, $match)) {
                throw new InvalidArgumentException('Invalid WebRTC ICE server URL.');
            }
            $scheme = strtolower($match[1]);
            $address = parse_url('//'.$match[2]);
            if (!$address || empty($address['host']) || isset($address['user']) || isset($address['pass'])
                || isset($address['path']) || isset($address['query']) || isset($address['fragment'])
                || (isset($address['port']) && ($address['port'] < 1 || $address['port'] > 65535))
                || preg_match('/\s/', $address['host'])) {
                throw new InvalidArgumentException('Invalid WebRTC ICE server URL.');
            }
            parse_str($match[3] ?? '', $query);
            if ((!$turn && ($scheme !== 'stun' || $query))
                || ($turn && !in_array($scheme, ['turn', 'turns'], true))
                || count(array_diff(array_keys($query), ['transport'])) > 0
                || (isset($query['transport']) && !in_array($query['transport'], ['udp', 'tcp'], true))
                || ($scheme === 'turns' && isset($query['transport']) && $query['transport'] !== 'tcp')) {
                throw new InvalidArgumentException('Invalid WebRTC ICE server URL or transport.');
            }
        }
        return array_values($urls);
    }
}
