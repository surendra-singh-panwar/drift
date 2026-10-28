<?php

return [
    'enabled' => (bool) env('DRIFT_PUBLIC_TUNNEL', false),
    'host' => env('DRIFT_TUNNEL_HOST'),
];
