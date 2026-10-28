<?php

use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware) {
        // SDP is a wire format: trimming its final CRLF makes Chrome reject it.
        $middleware->trimStrings(except: ['payload.sdp']);
        $middleware->trustHosts(at: fn () => config('tunnel.enabled')
            ? ['^'.preg_quote(config('tunnel.host'), '/').'$'] : [], subdomains: false);
        $middleware->web(append: [\App\Http\Middleware\AnonymousSession::class, \App\Http\Middleware\HandleInertiaRequests::class]);
    })
    ->withExceptions(function (Exceptions $exceptions) {
        $exceptions->render(function (\Predis\CommunicationException|\Predis\Connection\Resource\Exception\StreamInitException $e, \Illuminate\Http\Request $request) {
            if ($request->is('chat/*')) {
                return response()->json(['message' => 'Chat service is temporarily unavailable. Please try again shortly.'], 503);
            }
        });
    })->create();
