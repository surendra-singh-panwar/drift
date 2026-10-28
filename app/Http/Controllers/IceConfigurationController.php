<?php
namespace App\Http\Controllers;

use App\Services\IceConfiguration;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

class IceConfigurationController extends Controller
{
    public function __invoke(Request $request, IceConfiguration $configuration)
    {
        $input = $request->validate(['tab' => 'required|uuid', 'room' => 'required|uuid', 'membership' => 'sometimes|uuid']);
        $cache = Cache::store(config('chat.store'));
        return $cache->lock('chat:transition', 10)->block(5, function () use ($request, $configuration, $input, $cache) {
            $state = $cache->get('chat:state', ['users' => [], 'rooms' => []]);
            $id = $request->user()->id;
            $user = $state['users'][$id] ?? null;
            $room = $state['rooms'][$input['room']] ?? null;
            abort_unless($user && $room && $user['tab'] === $input['tab'] && $user['status'] === 'connected'
                && $user['room'] === $input['room'] && in_array($id, $room['members'], true)
                && in_array($user['mode'], ['video', 'group'], true)
                && $user['seen'] >= now()->timestamp - config('chat.lease')
                && $user['created'] >= now()->timestamp - config('chat.lifetime'), 403, 'An active video chat is required.');
            if ($user['mode'] === 'group') abort_unless(($input['membership'] ?? null) === ($room['epochs'][$id] ?? null), 403, 'Stale group membership.');
            return response()->json($configuration->make(true))->header('Cache-Control', 'no-store, private')->header('Pragma', 'no-cache');
        });
    }
}
