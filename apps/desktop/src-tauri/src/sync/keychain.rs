//! The sync grant in the keychain, where the File Provider extension reads it: the data
//! protection keychain, in the access group the two share (`<team>.<bundle id>`, the same value
//! `build-macos.sh` writes into the extension). The app holds the provisioning profile that
//! allows that group, so it writes here and `omni-sync` never touches the keychain.

use omni_sync_types::DesktopSyncTokens;
use security_framework::passwords::{
    PasswordOptions, generic_password, set_generic_password_options,
};
use tauri::{AppHandle, Runtime};

/// The team the build was signed for; without one (an unsigned build) the group is the bundle id.
const TEAM: Option<&str> = option_env!("APPLE_TEAM_ID");

fn options<R: Runtime>(app: &AppHandle<R>) -> PasswordOptions {
    let bundle = &app.config().identifier;
    let mut options = PasswordOptions::new_generic_password(&format!("{bundle}.sync"), "sync");
    options.use_protected_keychain();
    match TEAM.filter(|team| !team.is_empty()) {
        Some(team) => options.set_access_group(&format!("{team}.{bundle}")),
        None => options.set_access_group(bundle),
    }
    options
}

/// Whether a grant is kept. The extension deletes one the server refused, so a kept grant is
/// one that last worked.
pub fn holds<R: Runtime>(app: &AppHandle<R>) -> bool {
    generic_password(options(app)).is_ok()
}

pub fn store<R: Runtime>(app: &AppHandle<R>, tokens: &DesktopSyncTokens) -> Result<(), String> {
    let bytes = serde_json::to_vec(tokens).map_err(|error| error.to_string())?;
    set_generic_password_options(&bytes, options(app))
        .map_err(|error| format!("the sync grant could not be kept: {error}"))
}
