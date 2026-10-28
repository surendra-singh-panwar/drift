<?php
require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
config(['chat.store' => 'redis', 'cache.prefix' => $argv[1], 'broadcasting.default' => 'null']);
echo json_encode(app(App\Services\MatchmakingService::class)->act($argv[2], 'tab-'.$argv[2], 'start', ['mode' => $argv[3] ?? 'text']));
