<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        if (config('app.browser_test_build')) {
            // Isolated browser tests use built assets, independent of the user's Vite HMR.
            \Illuminate\Support\Facades\Vite::useHotFile(storage_path('framework/testing/no-vite.hot'));
        }
        if (config('tunnel.enabled')) {
            // Configure after Laravel has loaded config; only loopback is trusted.
            \Illuminate\Http\Middleware\TrustProxies::at(['127.0.0.1']);
            \Illuminate\Http\Middleware\TrustProxies::withHeaders(
                \Illuminate\Http\Request::HEADER_X_FORWARDED_FOR |
                \Illuminate\Http\Request::HEADER_X_FORWARDED_PROTO);
            \Illuminate\Support\Facades\Vite::useHotFile(storage_path('app/tunnel/no-development-server.hot'))
                ->useBuildDirectory('tunnel-build');
        }
        \Illuminate\Support\Facades\RateLimiter::for('chat-session', fn (\Illuminate\Http\Request $request) =>
            \Illuminate\Cache\RateLimiting\Limit::perMinute(90)->by('chat-session:'.$request->session()->getId()));
        \Illuminate\Support\Facades\RateLimiter::for('chat-ice', fn (\Illuminate\Http\Request $request) => [
            \Illuminate\Cache\RateLimiting\Limit::perMinute(12)->by('ice-session:'.$request->session()->get('anonymous_id', $request->session()->getId())),
            \Illuminate\Cache\RateLimiting\Limit::perMinute(120)->by('ice-ip:'.$request->ip()),
        ]);
        \Illuminate\Support\Facades\RateLimiter::for('chat-signal', fn (\Illuminate\Http\Request $request) => [
            \Illuminate\Cache\RateLimiting\Limit::perMinute(720)->by('signal-session:'.$request->session()->getId()),
            \Illuminate\Cache\RateLimiting\Limit::perMinute(3000)->by('signal-ip:'.$request->ip()),
        ]);
    }
}
