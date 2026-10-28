<?php

namespace App\Console\Commands;

use App\Services\MatchmakingService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;

class ReviewChatReport extends Command
{
    protected $signature = 'chat:review-report {report : Report UUID} {--remove : Confirm abuse and remove from the reported room} {--confirm : Explicitly confirm moderator removal}';
    protected $description = 'Inspect a private abuse report; optionally confirm and remove a current group member';

    public function handle(MatchmakingService $chat): int
    {
        $id = $this->argument('report');
        if (!Str::isUuid($id) || !Storage::disk('local')->exists('chat-reports/'.$id.'.json')) {
            $this->error('Report not found.');
            return self::FAILURE;
        }
        $path = 'chat-reports/'.$id.'.json';
        $report = json_decode(Storage::disk('local')->get($path), true, flags: JSON_THROW_ON_ERROR);
        if (!$this->option('remove')) {
            $this->line(json_encode($report, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));
            return self::SUCCESS;
        }
        if (!$this->option('confirm')) {
            $this->error('Review the report first. Removal requires --remove --confirm.');
            return self::FAILURE;
        }
        // Reports retain their server-generated namespace, including public tunnel runs.
        $saved = ['cache.prefix' => config('cache.prefix'), 'chat.store' => config('chat.store')];
        $store = $report['chat_store'] ?? $saved['chat.store'];
        $prefix = $report['cache_prefix'] ?? $saved['cache.prefix'];
        $changed = $store !== $saved['chat.store'] || $prefix !== $saved['cache.prefix'];
        try {
            if ($changed) { config(['cache.prefix' => $prefix, 'chat.store' => $store]); Cache::forgetDriver($store); }
            $removed = $chat->removeConfirmedParticipant($report['room'], $report['target']);
        } finally {
            if ($changed) { config($saved); Cache::forgetDriver($store); }
        }
        $report['status'] = 'confirmed';
        $report['reviewed_at'] = now()->toIso8601String();
        $report['removed_from_room'] = $removed;
        Storage::disk('local')->put($path, json_encode($report, JSON_THROW_ON_ERROR));
        $this->info($removed ? 'Participant removed from the reported room.' : 'Reviewed; participant is no longer in the reported room.');
        return self::SUCCESS;
    }
}
