<?php
namespace Tests\Feature;
use App\Services\MatchmakingService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class RedisConcurrencyTest extends TestCase
{
    public function test_concurrent_group_joins_never_overfill_or_duplicate_members(): void
    {
        if (!getenv('RUN_REDIS_TESTS')) $this->markTestSkipped('Requires RUN_REDIS_TESTS=1.');
        $prefix = 'drift-group-integration-'.Str::uuid().':';
        config(['chat.store' => 'redis', 'cache.prefix' => $prefix, 'broadcasting.default' => 'null']);
        $cache = Cache::store('redis');
        $cache->get('connectivity-probe');
        $workers = [];
        try {
            for ($i = 0; $i < 40; $i++) {
                $worker = new Process([PHP_BINARY, base_path('tests/Support/match-worker.php'), $prefix, 'group-user-'.($i % 20), 'group'], base_path());
                $worker->start(); $workers[] = $worker;
            }
            foreach ($workers as $worker) { $worker->wait(); $this->assertTrue($worker->isSuccessful(), $worker->getErrorOutput()); }
            $state = $cache->get('chat:state');
            $this->assertCount(5, $state['rooms']);
            $members = [];
            foreach ($state['rooms'] as $room => $data) {
                $this->assertCount(4, $data['members']);
                $this->assertCount(4, $data['epochs']);
                foreach ($data['members'] as $id) { $members[] = $id; $this->assertSame($room, $state['users'][$id]['room']); }
            }
            $this->assertCount(20, array_unique($members));
        } finally {
            foreach ($workers as $worker) if ($worker->isRunning()) $worker->stop();
            $cache->forget('chat:state');
        }
    }

    public function test_simultaneous_requests_reserve_each_user_exactly_once(): void
    {
        if (!getenv('RUN_REDIS_TESTS')) $this->markTestSkipped('Requires Redis: set RUN_REDIS_TESTS=1 to run real concurrent PHP workers.');
        $prefix = 'drift-integration-'.Str::uuid().':';
        config(['chat.store' => 'redis', 'cache.prefix' => $prefix, 'broadcasting.default' => 'null']);
        $cache = Cache::store('redis');
        // Fail at the actual connection attempt, before launching workers or cleanup.
        $cache->get('connectivity-probe');
        $workers = [];
        try {
            // Two simultaneous Start requests for each of twelve distinct sessions.
            for ($i = 0; $i < 24; $i++) {
                $process = new Process([PHP_BINARY, base_path('tests/Support/match-worker.php'), $prefix, 'user-'.($i % 12)], base_path());
                $process->start(); $workers[] = $process;
            }
            foreach ($workers as $worker) { $worker->wait(); $this->assertTrue($worker->isSuccessful(), $worker->getErrorOutput()); }
            $state = $cache->get('chat:state');
            $this->assertCount(12, $state['users']);
            $this->assertCount(6, $state['rooms']);
            $members = [];
            foreach ($state['rooms'] as $room => $data) {
                $this->assertCount(2, array_unique($data['members']));
                foreach ($data['members'] as $id) { $members[] = $id; $this->assertSame($room, $state['users'][$id]['room']); }
            }
            $this->assertCount(12, array_unique($members));
        } finally {
            foreach ($workers as $worker) if ($worker->isRunning()) $worker->stop();
            $cache->forget('chat:state');
        }
    }
}
