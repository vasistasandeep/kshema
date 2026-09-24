// Redirects this Next app's `.next` build directory OUT of the (OneDrive-synced)
// project tree by making `.next` a Windows directory JUNCTION to a folder under
// %LOCALAPPDATA%. OneDrive syncs the project folder and turns files into
// placeholder/reparse points, which breaks Next's cache management
// (EINVAL readlink) and webpack's on-disk cache ("not valid JSON"). A junction
// is not a synced placeholder, so Next reads/writes through it normally.
//
// Runs automatically via the `predev`/`prebuild` npm hooks. Idempotent and a
// no-op on non-Windows platforms (where the OneDrive issue does not apply).
import { mkdirSync, existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir, platform } from "node:os";

if (platform() !== "win32") {
  process.exit(0);
}

const appDir = process.cwd();
const appName = basename(appDir);
const dotNext = join(appDir, ".next");
const target = join(
  process.env.KSHEMA_BUILD_DIR ?? join(process.env.LOCALAPPDATA ?? tmpdir(), "kshema-build"),
  appName,
  ".next",
);

try {
  mkdirSync(target, { recursive: true });

  if (existsSync(dotNext)) {
    const st = lstatSync(dotNext);
    // Already a junction/symlink -> leave it. A real dir -> remove so we can link.
    if (st.isSymbolicLink()) {
      process.exit(0);
    }
    rmSync(dotNext, { recursive: true, force: true });
  }

  // "junction" needs no admin rights on Windows and works for directories.
  symlinkSync(target, dotNext, "junction");
  console.log(`[predev] .next -> ${target} (junction)`);
} catch (err) {
  // Never block dev over this; Next will just use an in-tree .next if it fails.
  console.warn(`[predev] could not relocate .next: ${err?.message ?? err}`);
}
