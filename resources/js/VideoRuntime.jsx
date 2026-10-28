import { useEffect } from 'react';
import { useVideoCall } from './use-video-call';

export default function VideoRuntime({ options, publish }) {
    const call = useVideoCall(options);
    useEffect(() => {
        publish(call, Object.fromEntries(['localStream', 'remoteStream', 'status', 'error', 'microphoneEnabled',
            'cameraEnabled', 'facingMode', 'switchingCamera'].map(key => [key, call[key]])));
    });
    return null;
}
