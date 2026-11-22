/**
 * Downsamples the captured screenshots from 2x to 1x for the README.
 *
 * `capture-screenshots.mjs` shoots at 2x device scale so text renders sharply, but
 * the resulting files are ~5.5 MB in total and GitHub displays them at 1x anyway.
 * Halving them keeps the set around 1.5 MB with no visible loss.
 *
 * Usage:
 *   node scripts/shrink-screenshots.mjs
 *
 * Windows has no ImageMagick by default, so this uses System.Drawing through
 * PowerShell. On other platforms it does nothing and prints a note — the committed
 * images are already the right size, this only matters when re-capturing.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs', 'screenshots');

if (process.platform !== 'win32') {
  console.log('Not Windows: leaving the committed screenshots as they are.');
  console.log(`Replace files in ${DIR} with 1x versions before committing.`);
  process.exit(0);
}

const script = `
Add-Type -AssemblyName System.Drawing
$dir = '${DIR.replace(/'/g, "''")}'
$before = 0; $after = 0
Get-ChildItem -Path $dir -Filter *.png | ForEach-Object {
  $before += $_.Length
  $src = [System.Drawing.Image]::FromFile($_.FullName)
  $w = [int]($src.Width / 2); $h = [int]($src.Height / 2)
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $w, $h)
  $g.Dispose(); $src.Dispose()
  $tmp = $_.FullName + '.tmp'
  $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Move-Item $tmp $_.FullName -Force
  $after += (Get-Item $_.FullName).Length
}
"shrunk: {0:N2} MB -> {1:N2} MB" -f ($before / 1MB), ($after / 1MB)
`;

try {
  const output = execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8' },
  );
  console.log(output.trim());
} catch (error) {
  console.error(`FAILED to shrink screenshots: ${error.message}`);
  process.exitCode = 1;
}
