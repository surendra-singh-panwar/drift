<?php

use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Broadcast;
use App\Http\Controllers\ChatController;

Route::get('/', [ChatController::class, 'index']);
Route::post('/chat/ice', \App\Http\Controllers\IceConfigurationController::class)->middleware('throttle:chat-ice');
Route::post('/chat/signal', [ChatController::class, 'action'])->defaults('action', 'signal')->middleware('throttle:chat-signal');
Route::post('/chat/{action}', [ChatController::class, 'action'])->where('action', 'start|next|stop|heartbeat|message|report|block')->middleware(['throttle:90,1', 'throttle:chat-session']);
Broadcast::routes(['middleware' => ['web', 'throttle:120,1']]);
Broadcast::channel('anonymous.{id}', fn ($user, $id) => hash_equals((string) $user->id, $id));
