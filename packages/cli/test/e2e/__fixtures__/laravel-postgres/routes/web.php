<?php

use App\Jobs\RecordConnection;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Foundation\Http\Middleware\ValidateCsrfToken;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Route;

Route::get('/', function () {
    return view('welcome');
});

// The Docker pass queues a job here, then reads back the database connection the worker found.
Route::withoutMiddleware([PreventRequestForgery::class, ValidateCsrfToken::class])->group(function () {
    Route::post('/jobs/{id}', function (string $id) {
        RecordConnection::dispatch($id);

        return response('queued', 202);
    });
    Route::get('/jobs/{id}', function (string $id) {
        $connection = Cache::get('job:'.$id);

        return $connection === null ? response('waiting', 404) : response($connection);
    });
});
