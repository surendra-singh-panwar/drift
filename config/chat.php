<?php
return ['store' => env('CHAT_STORE', 'redis'), 'lease' => 45, 'lifetime' => 3600];
