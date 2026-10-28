<?php

require dirname(__DIR__, 2).'/vendor/autoload.php';
$app = require dirname(__DIR__, 2).'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

if (!\Illuminate\Support\Str::isUuid($argv[1] ?? '') || !\Illuminate\Support\Str::isUuid($argv[2] ?? '')) {
    fwrite(STDERR, "Usage: php tests/Support/broadcast-probe.php <anonymous UUID> <probe UUID>\n");
    exit(1);
}

event(new \App\Events\ChatUpdated($argv[1], ['type' => 'verification', 'nonce' => $argv[2]]));
echo "Private Reverb probe broadcast sent.\n";
