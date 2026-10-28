<?php

require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$cache = Illuminate\Support\Facades\Cache::store(config('chat.store'));
$state = $cache->get('chat:state', ['users' => [], 'rooms' => []]);
$stale = array_filter($state['users'], fn ($user) => $user['seen'] < time() - config('chat.lease') || $user['created'] < time() - config('chat.lifetime'));
$store = $cache->getStore();
echo json_encode([
    'users' => count($state['users']),
    'stale_users' => count($stale),
    'searching_users' => count(array_filter($state['users'], fn ($u) => $u['status'] === 'searching')),
    'rooms' => count($state['rooms']),
    'snapshot_ttl' => $store->connection()->ttl($store->getPrefix().'chat:state'),
    'transition_lock_ttl' => $store->lockConnection()->ttl($store->getPrefix().'chat:transition'),
], JSON_PRETTY_PRINT).PHP_EOL;
