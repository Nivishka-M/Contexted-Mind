# Contexted Mind

A small always-on-top orb that holds your current task and a tree of tasks and subtasks.

- **Hover** the orb to see your current task.
- **Click** it to blur the desktop and open the tree, where you can add, edit, delete, finish and focus tasks.
- **Drag** it by the small ✥ handle. It remembers where you left it.
- **Esc** or a click on the blurred background closes the tree. **Quit** is in the tree's header, because the orb has no taskbar entry.

Tasks are saved to `%APPDATA%\contexted-mind\tasks.json` on Windows and `~/.config/contexted-mind/tasks.json` on Fedora. The desktop snapshot behind the blur stays in memory and is dropped when the tree closes.

## Windows 11

Run one of the installers in `src-tauri\target\release\bundle\`: `nsis\Contexted Mind_0.1.0_x64-setup.exe` or `msi\Contexted Mind_0.1.0_x64_en-US.msi`.

To rebuild, you need Rust and the Microsoft C++ Build Tools. With Node.js installed:

```bash
npx @tauri-apps/cli@2 build --bundles msi,nsis
```

## Fedora

The RPM has to be built on Fedora itself:

```bash
sudo dnf install rust cargo webkit2gtk4.1-devel openssl-devel curl wget file libappindicator-gtk3-devel librsvg2-devel libxcb-devel dbus-devel pipewire-devel wayland-devel libxkbcommon-devel mesa-libgbm-devel clang-devel rpm-build
```

```bash
cargo install tauri-cli --version "^2" --locked
```

```bash
cargo tauri build --bundles rpm
```

```bash
sudo dnf install "./src-tauri/target/release/bundle/rpm/Contexted Mind-0.1.0-1.x86_64.rpm"
```

On Wayland the app runs through XWayland so that always-on-top and positioning work. The desktop may ask for permission to take a screenshot the first time you open the tree. If you decline, the tree opens over a solid dark background instead.

## Tests

```bash
node --test tests/tree.test.js
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```
