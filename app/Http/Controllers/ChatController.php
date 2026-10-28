<?php
namespace App\Http\Controllers;
use App\Services\MatchmakingService;
use Illuminate\Http\Request;
use Inertia\Inertia;
class ChatController extends Controller
{
    public function index(Request $request) {
        return Inertia::render('ChatPage', [
            'channel' => 'anonymous.'.$request->user()->id,
            'reverb' => config('tunnel.enabled') ? [
                'key' => config('broadcasting.connections.reverb.key'),
                'host' => config('tunnel.host'),
                'port' => 443,
                'scheme' => 'https',
            ] : null,
            'webrtc' => app(\App\Services\IceConfiguration::class)->make(),
        ]);
    }
    public function action(Request $request, string $action, MatchmakingService $service)
    {
        abort_unless(in_array($action, ['start', 'next', 'stop', 'heartbeat', 'message', 'signal', 'report', 'block']), 404);
        $rules = ['tab' => 'required|uuid', 'membership' => 'sometimes|uuid'];
        if ($action === 'start') $rules += ['mode' => 'sometimes|in:text,video,group'];
        if (in_array($action, ['report', 'block'], true)) $rules += ['room' => 'required|uuid', 'target' => 'required|uuid'];
        if ($action === 'report') $rules += ['reason' => 'required|string|min:3|max:1000'];
        if ($action === 'message') $rules += ['room' => 'required|uuid', 'id' => 'required|uuid', 'text' => 'required|string|max:2000'];
        if ($action === 'signal') {
            $rules += [
                'room' => 'required|uuid', 'instance' => 'required|uuid', 'negotiation' => 'required|uuid',
                'kind' => 'required|in:ready,restart,offer,answer,ice,ice-batch',
                'sequence' => 'required|integer|between:1,2147483647',
                'to' => 'sometimes|uuid', 'targetMembership' => 'sometimes|uuid',
            ];
            $kind = $request->input('kind');
            if (in_array($kind, ['offer', 'answer'], true)) {
                $rules += ['payload' => 'required|array:sdp', 'payload.sdp' => 'required|string|starts_with:v=0|max:60000'];
            } elseif (in_array($kind, ['ice', 'ice-batch'], true)) {
                $prefix = $kind === 'ice-batch' ? 'payload.candidates.*' : 'payload';
                if ($kind === 'ice-batch') $rules += [
                    'payload' => 'required|array:candidates',
                    'payload.candidates' => 'required|array|min:1|max:10',
                    'payload.candidates.*' => 'required|array:candidate,sdpMid,sdpMLineIndex,usernameFragment',
                ];
                else $rules += ['payload' => 'required|array:candidate,sdpMid,sdpMLineIndex,usernameFragment'];
                $rules += [
                    $prefix.'.candidate' => 'present|nullable|string|max:4096',
                    $prefix.'.sdpMid' => 'sometimes|nullable|string|max:256',
                    $prefix.'.sdpMLineIndex' => 'sometimes|nullable|integer|between:0,65535',
                    $prefix.'.usernameFragment' => 'sometimes|nullable|string|max:256',
                ];
            } else {
                $rules += ['payload' => 'prohibited'];
            }
        }
        $data = $request->validate($rules);
        if ($action === 'message') { $data['text'] = trim($data['text']); abort_if($data['text'] === '', 422, 'Message cannot be blank.'); }
        // Bound bytes as well as character counts before forwarding to Reverb.
        if ($action === 'signal') abort_if(strlen(json_encode($data['payload'] ?? null)) > 100000, 422, 'Signaling payload is too large.');
        return response()->json(collect($service->act($request->user()->id, $data['tab'], $action, $data))->only(['status', 'room', 'mode', 'initiator', 'online', 'message', 'revision', 'self', 'members', 'epochs', 'report']));
    }

}
