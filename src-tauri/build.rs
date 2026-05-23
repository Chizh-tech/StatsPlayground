fn main() {
    // Force cargo to re-run this build script (which re-embeds the bundle
    // icons into the binary) whenever any file under icons/ changes.
    // Without this, `tauri dev` keeps showing a stale dock icon after the
    // PNG/ICNS files are regenerated.
    println!("cargo:rerun-if-changed=icons");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    tauri_build::build()
}
