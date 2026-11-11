<?php
declare(strict_types=1);

// Checks the PHP reminder rules (server/api/app/lib/reminders.php) against the
// golden cases in test/fixtures/reminders/, which hold what the TypeScript
// rules produce (src/reminders.golden.test.ts writes them). Reminder emails
// must list exactly what the in-app bell shows.
//   npm run test:php   (php test/reminders-parity.php) — exits 1 on any difference

require __DIR__ . '/../server/api/app/lib/reminders.php';

$files = glob(__DIR__ . '/fixtures/reminders/*.json') ?: [];
if ($files === []) {
    fwrite(STDERR, "No golden cases in test/fixtures/reminders/ — run `npm test` to write them.\n");
    exit(1);
}

$line = static fn(array $r): string => json_encode($r, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
$failed = 0;
foreach ($files as $file) {
    $name = basename($file, '.json');
    $case = json_decode((string)file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
    $actual = Reminders::build($case['schedule'], $case['accounts'], $case['subscriptions'], $case['today']);
    if ($actual === $case['expected']) {
        echo "  ok    $name (" . count($actual) . " reminders)\n";
        continue;
    }
    $failed++;
    echo "  FAIL  $name\n";
    $expected = array_map($line, $case['expected']);
    $got = array_map($line, $actual);
    foreach (array_diff($expected, $got) as $l) {
        echo "    - expected $l\n";
    }
    foreach (array_diff($got, $expected) as $l) {
        echo "    + got      $l\n";
    }
    if (array_diff($expected, $got) === [] && array_diff($got, $expected) === []) {
        echo "    same reminders in a different order:\n      " . implode("\n      ", $got) . "\n";
    }
}

$total = count($files);
echo $failed === 0 ? "\n$total cases: PHP matches the TypeScript reminders\n" : "\n$failed of $total cases differ\n";
exit($failed === 0 ? 0 : 1);
