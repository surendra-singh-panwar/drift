<?php
namespace App\Services;
use App\Events\ChatUpdated;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\Storage;

/** All transitions and membership checks share one Redis lock. Message and signaling bodies are never stored. */
class MatchmakingService
{
    public function act(string $id, string $tab, string $action, array $input = []): array
    {
        $cache = Cache::store(config('chat.store'));
        $result = $cache->lock('chat:transition', 10)->block(5, function () use ($cache, $id, $tab, $action, $input) {
            $state = $cache->get('chat:state', ['users' => [], 'rooms' => []]);
            $now = now()->timestamp;
            $events = [];
            $state['revision'] = max(($state['revision'] ?? 0) + 1, (int) (microtime(true) * 1000000));
            foreach ($state['users'] as $uid => $user) {
                if ($user['seen'] < $now - config('chat.lease') || $user['created'] < $now - config('chat.lifetime')) {
                    $this->end($state, $uid, $events);
                    unset($state['users'][$uid]);
                }
            }
            $user = $state['users'][$id] ?? null;
            abort_if($user && $user['tab'] !== $tab, 409, 'This session is active in another tab.');
            $state['users'][$id] ??= ['status' => 'idle', 'room' => null, 'seen' => $now, 'created' => $now, 'tab' => $tab, 'mode' => 'text'];
            // Treat state written before video support as text chat.
            $state['users'][$id]['mode'] ??= 'text';
            $state['users'][$id]['seen'] = $now;
            $previousRoom = $state['users'][$id]['room'];
            if (in_array($action, ['report', 'block'], true)) {
                $room = $input['room'];
                $target = $input['target'];
                abort_unless($state['users'][$id]['mode'] === 'group' && $previousRoom === $room && $id !== $target && in_array($target, $state['rooms'][$room]['members'] ?? [], true), 403, 'Participant is no longer in your group.');
                abort_unless(($input['membership'] ?? null) === $state['rooms'][$room]['epochs'][$id], 403, 'Stale group membership.');
                if ($action === 'report') {
                    $reportId = (string) Str::uuid();
                    abort_unless(Storage::disk('local')->put('chat-reports/'.$reportId.'.json', json_encode([
                        'id' => $reportId, 'room' => $room, 'reporter' => $id, 'target' => $target,
                        'reason' => $input['reason'], 'created_at' => now()->toIso8601String(), 'status' => 'pending',
                        'cache_prefix' => config('cache.prefix'), 'chat_store' => config('chat.store'),
                    ], JSON_THROW_ON_ERROR)), 503, 'Unable to save report. Please try again.');
                } else {
                    $state['users'][$id]['blocks'][hash('sha256', $target)] = true;
                }
            }
            if (in_array($action, ['stop', 'next', 'block'])) $this->end($state, $id, $events);
            if (in_array($action, ['start', 'next', 'block']) && $state['users'][$id]['status'] === 'idle') {
                if ($action === 'start') $state['users'][$id]['mode'] = $input['mode'] ?? 'text';
                abort_unless(in_array($state['users'][$id]['mode'], ['text', 'video', 'group'], true), 422, 'Invalid chat mode.');
                $state['users'][$id]['status'] = 'searching';
                $mode = $state['users'][$id]['mode'];
                $candidates = array_keys(array_filter($state['users'], fn ($u, $uid) => $uid !== $id && $u['status'] === 'searching' && ($u['mode'] ?? 'text') === $mode, ARRAY_FILTER_USE_BOTH));
                if ($mode === 'group') {
                    $this->joinGroup($state, $id, $previousRoom, $events);
                } elseif ($candidates) {
                    $peer = $candidates[random_int(0, count($candidates) - 1)];
                    $room = (string) Str::uuid();
                    $state['rooms'][$room] = ['members' => [$id, $peer], 'dedupe' => []];
                    foreach ([$id, $peer] as $uid) {
                        $state['users'][$uid]['status'] = 'connected';
                        $state['users'][$uid]['room'] = $room;
                        $events[] = [$uid, ['type' => 'matched', 'room' => $room, 'mode' => $mode, 'initiator' => $mode === 'video' && $uid === $id]];
                    }
                }
            }
            $message = null;
            if (in_array($action, ['message', 'signal'], true)) {
                $room = $input['room'];
                abort_unless($state['users'][$id]['status'] === 'connected' && $state['users'][$id]['room'] === $room && isset($state['rooms'][$room]) && in_array($id, $state['rooms'][$room]['members'], true), 403, 'Chat is no longer active.');
            }
            if ($action === 'signal') {
                $group = $state['users'][$id]['mode'] === 'group';
                abort_unless($group || $state['users'][$id]['mode'] === 'video', 403, 'Video signaling requires an active video chat.');
                $target = $group ? ($input['to'] ?? null) : null;
                if ($group) {
                    abort_unless($target !== $id && in_array($target, $state['rooms'][$room]['members'], true), 403, 'Recipient is no longer in your group.');
                    abort_unless(($input['membership'] ?? null) === $state['rooms'][$room]['epochs'][$id] && ($input['targetMembership'] ?? null) === $state['rooms'][$room]['epochs'][$target], 403, 'Stale group membership.');
                }
                $initiator = $group ? strcmp($id, $target) > 0 : $state['rooms'][$room]['members'][0] === $id;
                abort_if(($input['kind'] === 'offer' && !$initiator) || ($input['kind'] === 'answer' && $initiator), 403, 'Invalid signaling role.');
                // Retain only hashed instance identifiers and counters, never SDP/ICE.
                // A retired browser instance cannot resume sending after refresh/retry.
                $instance = hash('sha256', $input['instance']);
                $key = $group ? $id.':'.$target : $id;
                $signaling = &$state['rooms'][$room]['signaling'][$key];
                $signaling ??= ['active' => null, 'sequences' => []];
                if ($signaling['active'] !== $instance) {
                    abort_if(isset($signaling['sequences'][$instance]), 409, 'This video connection has been replaced.');
                    abort_if(count($signaling['sequences']) >= 128, 429, 'Choose Next to start a fresh video session.');
                    $signaling['active'] = $instance;
                }
                abort_if($input['sequence'] <= ($signaling['sequences'][$instance] ?? 0), 409, 'Stale signaling sequence.');
                $signaling['sequences'][$instance] = $input['sequence'];
                unset($signaling);
                foreach ($state['rooms'][$room]['members'] as $uid) {
                    if ($uid !== $id && (!$group || $uid === $target)) $events[] = [$uid, [
                        'type' => 'signal', 'room' => $room, 'kind' => $input['kind'],
                        'from' => $id,
                        'membership' => $group ? $state['rooms'][$room]['epochs'][$id] : null,
                        'targetMembership' => $group ? $state['rooms'][$room]['epochs'][$target] : null,
                        'instance' => $input['instance'], 'negotiation' => $input['negotiation'],
                        'payload' => $input['payload'] ?? null,
                    ]];
                }
            }
            if ($action === 'message') {
                if ($state['users'][$id]['mode'] === 'group') abort_unless(($input['membership'] ?? null) === $state['rooms'][$room]['epochs'][$id], 403, 'Stale group membership.');
                $key = $id.':'.$input['id'];
                $message = ['id' => $input['id'], 'room' => $room, 'text' => $input['text'], 'from' => $id];
                if (!isset($state['rooms'][$room]['dedupe'][$key])) {
                    $state['rooms'][$room]['dedupe'][$key] = $now;
                    foreach ($state['rooms'][$room]['members'] as $uid) {
                        if ($uid !== $id) $events[] = [$uid, ['type' => 'message', ...$message]];
                    }
                }
            }
            // One authoritative membership snapshot per recipient/room/transition,
            // including when several expired participants are pruned together.
            $membershipEvents = [];
            $otherEvents = [];
            foreach ($events as [$recipient, $data]) {
                if ($data['type'] !== 'group-members') { $otherEvents[] = [$recipient, $data]; continue; }
                $groupRoom = $state['rooms'][$data['room']] ?? null;
                if (!$groupRoom || !in_array($recipient, $groupRoom['members'], true)) continue;
                $membershipEvents[$recipient.':'.$data['room']] = [$recipient, [...$data, 'members' => $groupRoom['members'], 'epochs' => $groupRoom['epochs']]];
            }
            $events = [...$otherEvents, ...array_values($membershipEvents)];
            $cache->put('chat:state', $state, config('chat.lifetime') + 60);
            $activeRoom = $state['users'][$id]['room'];
            $initiator = $state['users'][$id]['mode'] === 'video' && $activeRoom !== null && ($state['rooms'][$activeRoom]['members'][0] ?? null) === $id;
            return [...$state['users'][$id], 'self' => $id, 'members' => $state['rooms'][$activeRoom]['members'] ?? [], 'epochs' => $state['rooms'][$activeRoom]['epochs'] ?? [], 'report' => $reportId ?? null, 'initiator' => $initiator, 'revision' => $state['revision'], 'online' => count($state['users']), 'message' => $message, '_events' => $events];
        });
        // Network I/O must never outlive the atomic transition lock.
        foreach ($result['_events'] as [$recipient, $data]) event(new ChatUpdated($recipient, [...$data, 'revision' => $result['revision']]));
        unset($result['_events']);
        return $result;
    }
    private function end(array &$state, string $id, array &$events): void
    {
        $room = $state['users'][$id]['room'] ?? null;
        if (($state['rooms'][$room]['mode'] ?? null) === 'group') {
            $members = array_values(array_diff($state['rooms'][$room]['members'], [$id]));
            $state['users'][$id]['status'] = 'idle';
            $state['users'][$id]['room'] = null;
            if (!$members) { unset($state['rooms'][$room]); return; }
            $state['rooms'][$room]['members'] = $members;
            unset($state['rooms'][$room]['epochs'][$id]);
            // A group can outlive any one member; don't retain departed message UUIDs.
            foreach (array_keys($state['rooms'][$room]['dedupe']) as $key) {
                if (str_starts_with($key, $id.':')) unset($state['rooms'][$room]['dedupe'][$key]);
            }
            foreach (array_keys($state['rooms'][$room]['signaling'] ?? []) as $key) {
                if (in_array($id, explode(':', $key), true)) unset($state['rooms'][$room]['signaling'][$key]);
            }
            foreach ($members as $uid) $events[] = [$uid, ['type' => 'group-members', 'change' => 'left', 'participant' => $id, 'room' => $room, 'mode' => 'group', 'members' => $members, 'epochs' => $state['rooms'][$room]['epochs']]];
            return;
        }
        foreach ($state['rooms'][$room]['members'] ?? [$id] as $uid) {
            if (isset($state['users'][$uid])) {
                $state['users'][$uid]['status'] = 'idle';
                $state['users'][$uid]['room'] = null;
                if ($uid !== $id) $events[] = [$uid, ['type' => 'ended', 'room' => $room, 'reason' => 'Stranger disconnected.']];
            }
        }
        if ($room) unset($state['rooms'][$room]);
    }

    private function joinGroup(array &$state, string $id, ?string $previousRoom, array &$events): void
    {
        $eligible = [];
        foreach ($state['rooms'] as $room => $data) {
            if (($data['mode'] ?? null) !== 'group' || $room === $previousRoom || count($data['members']) >= 8 || isset($data['removed'][hash('sha256', $id)])) continue;
            foreach ($data['members'] as $member) {
                if (isset($state['users'][$id]['blocks'][hash('sha256', $member)]) || isset($state['users'][$member]['blocks'][hash('sha256', $id)])) continue 2;
            }
            $eligible[$room] = count($data['members']);
        }
        if ($eligible) {
            $fullest = array_keys($eligible, max($eligible), true);
            $room = $fullest[random_int(0, count($fullest) - 1)];
        } else {
            $room = (string) Str::uuid();
            $state['rooms'][$room] = ['mode' => 'group', 'members' => [], 'dedupe' => []];
        }
        $state['rooms'][$room]['members'][] = $id;
        $state['rooms'][$room]['epochs'][$id] = (string) Str::uuid();
        $state['users'][$id]['room'] = $room;
        $state['users'][$id]['status'] = 'connected';
        foreach ($state['rooms'][$room]['members'] as $uid) $events[] = [$uid, [
            'type' => 'group-members', 'change' => 'joined', 'participant' => $id,
            'room' => $room, 'mode' => 'group', 'members' => $state['rooms'][$room]['members'],
            'epochs' => $state['rooms'][$room]['epochs'],
        ]];
    }

    /** Only the local moderator command calls this after explicit report confirmation. */
    public function removeConfirmedParticipant(string $room, string $target): bool
    {
        $cache = Cache::store(config('chat.store'));
        $events = $cache->lock('chat:transition', 10)->block(5, function () use ($cache, $room, $target) {
            $state = $cache->get('chat:state', ['users' => [], 'rooms' => []]);
            if (($state['rooms'][$room]['mode'] ?? null) !== 'group' || !in_array($target, $state['rooms'][$room]['members'], true)) return null;
            $state['revision'] = max(($state['revision'] ?? 0) + 1, (int) (microtime(true) * 1000000));
            $state['rooms'][$room]['removed'][hash('sha256', $target)] = true;
            $events = [];
            $this->end($state, $target, $events);
            $events[] = [$target, ['type' => 'ended', 'room' => $room, 'reason' => 'Removed from this group after moderator review.']];
            $cache->put('chat:state', $state, config('chat.lifetime') + 60);
            return array_map(fn ($event) => [$event[0], [...$event[1], 'revision' => $state['revision']]], $events);
        });
        foreach ($events ?? [] as [$recipient, $data]) event(new ChatUpdated($recipient, $data));
        return $events !== null;
    }
}
