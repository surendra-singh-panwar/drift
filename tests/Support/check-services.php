<?php

require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Str;

try {
    $host = config('database.redis.default.host');
    $port = config('database.redis.default.port');
    echo "Redis endpoint: {$host}:{$port}\n";
    echo 'Laravel Redis client: '.config('database.redis.client')."\n";
    echo 'Laravel Redis PING: '.Redis::connection()->ping()."\n";
    echo 'Laravel Redis cache PING: '.Redis::connection('cache')->ping()."\n";
    $key = 'drift:verification:'.Str::uuid();
    $cache = Cache::store('redis');
    try {
        $cache->put($key, 'verified', 30);
        if ($cache->get($key) !== 'verified') throw new RuntimeException('Cache read/write failed.');
        $cache->lock($key.':lock', 5)->block(2, fn () => print("Laravel Redis cache read/write/lock: PASS\n"));
    } finally {
        $cache->forget($key);
    }
    echo 'Broadcast driver: '.config('broadcasting.default')."\n";
    echo 'Reverb endpoint: '.config('broadcasting.connections.reverb.options.host').':'.config('broadcasting.connections.reverb.options.port')."\n";
} catch (Throwable $e) {
    fwrite(STDERR, get_class($e).': '.$e->getMessage()."\n");
    exit(1);
}
