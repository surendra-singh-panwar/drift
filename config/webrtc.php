<?php

$urls = fn ($value) => array_values(array_filter(array_map('trim', explode(',', $value ?? ''))));
$positiveValues = fn ($value, $default) => array_values(array_filter(
    array_map(fn ($item) => (int) trim($item), explode(',', $value ?? '')),
    fn ($item) => $item > 0
)) ?: $default;

return [
    'stun_urls' => $urls(env('STUN_URLS', 'stun:stun.l.google.com:19302')),
    'turn_urls' => $urls(env('TURN_URLS', '')),
    // TURN REST shared secret stays on the server. Browsers receive short-lived HMAC credentials.
    'turn_secret' => env('TURN_SECRET'),
    'turn_ttl' => max(300, min(86400, (int) env('TURN_TTL', 7200))),
    // Static TURN credentials are optional; they are necessarily visible to browser clients.
    'turn_username' => env('TURN_USERNAME'),
    'turn_password' => env('TURN_PASSWORD'),
    'ice_transport_policy' => env('WEBRTC_ICE_TRANSPORT_POLICY', 'all') === 'relay' ? 'relay' : 'all',
    'disconnect_grace_ms' => max(1000, min(15000, (int) env('WEBRTC_DISCONNECT_GRACE_MS', 4000))),
    'connect_timeout_ms' => max(10000, min(120000, (int) env('WEBRTC_CONNECT_TIMEOUT_MS', 30000))),
    'group_connect_timeout_ms' => max(10000, min(120000, (int) env('WEBRTC_GROUP_CONNECT_TIMEOUT_MS', 60000))),
    'recovery_timeout_ms' => max(5000, min(60000, (int) env('WEBRTC_RECOVERY_TIMEOUT_MS', 15000))),
    'recovery_attempts' => max(1, min(5, (int) env('WEBRTC_RECOVERY_ATTEMPTS', 3))),
    'recovery_backoff_ms' => $positiveValues(env('WEBRTC_RECOVERY_BACKOFF_MS', '1000,3000,7000'), [1000, 3000, 7000]),
];
