<?php

namespace App\Jobs;

use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;

/** Records the database connection the worker's settings name, under the id it was queued with. */
class RecordConnection implements ShouldQueue
{
    use Queueable;

    public function __construct(public string $id) {}

    public function handle(): void
    {
        Cache::forever('job:'.$this->id, config('database.default'));
    }
}
