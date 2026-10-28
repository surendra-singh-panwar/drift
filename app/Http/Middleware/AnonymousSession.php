<?php
namespace App\Http\Middleware;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Str;
use Illuminate\Auth\GenericUser;
class AnonymousSession
{
    public function handle(Request $request, Closure $next)
    {
        if (!$request->session()->has('anonymous_id')) $request->session()->put('anonymous_id', (string) Str::uuid());
        $user = new GenericUser(['id' => $request->session()->get('anonymous_id')]);
        $request->setUserResolver(fn () => $user);
        return $next($request);
    }
}
