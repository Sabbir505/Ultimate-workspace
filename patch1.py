import io
p = "src/browser.rs"
src = io.open(p, encoding="utf-8").read()

anchor = "/// JS snippet that monkey-patches history.pushState"
helpers = r'''// ---- Direct WebView2 creation (Windows) ------------------------------------
// Mirrors wry's env-to-controller sequence but fires ASYNC completions
// against the main thread's normal pump - never a nested wait_with_pump,
// never a tauri dispatcher message.

/// Shared "report creation outcome once" handle.
#[cfg(windows)]
type DoneHandle = std::sync::Arc<Mutex<Option<mpsc::Sender<Result<(), String>>>>>;

#[cfg(windows)]
fn take_done(done: &DoneHandle, r: Result<(), String>) {
    if let Some(tx) = done.lock().take() {
        let _ = tx.send(r);
    }
}

/// Kick off CreateCoreWebView2EnvironmentWithOptions; the completion fires on
/// the main thread's pump and hands the environment to `on_env`.
#[cfg(windows)]
fn create_environment_async(
    data_dir: &std::path::Path,
    done: DoneHandle,
    on_env: impl FnOnce(
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    ) -> Result<(), String>
    + Send
    + 'static,
) -> Result<(), String> {
    use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::CreateCoreWebView2EnvironmentWithOptions;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2EnvironmentOptions;
    use windows::core::HSTRING;

    let options = webview2_com::CoreWebView2EnvironmentOptions::default();
    // wry's defaults: drop the mini menu + smart screen popups.
    options.set_additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
        move |hr, environment| {
            let res = (|| -> Result<(), String> {
                hr.map_err(|e| format!("environment creation failed: {e}"))?;
                let env = match environment {
                    Some(e) => e,
                    None => {
                        take_done(&done, Err("environment creation returned none".into()));
                        return Ok(());
                    }
                };
                on_env(env)
            })();
            if let Err(e) = res {
                take_done(&done, Err(e));
            }
            Ok(())
        },
    ));
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            windows::core::PCWSTR::null(),
            &HSTRING::from(data_dir.as_os_str()),
            &ICoreWebView2EnvironmentOptions::from(options),
            &handler,
        )
    }
    .map_err(|e| format!("CreateEnvironment invoke failed: {e}"))?;
    Ok(())
}

/// Kick off controller creation against `hwnd`; completion hands the
/// controller (bounds already applied) to `on_controller`.
#[cfg(windows)]
fn create_controller_async(
    hwnd: windows::Win32::Foundation::HWND,
    env: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment,
    bounds: windows::Win32::Foundation::RECT,
    done: DoneHandle,
    on_controller: impl FnOnce(
        webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    ) -> Result<(), String>
    + Send
    + 'static,
) -> Result<(), String> {
    use webview2_com::CreateCoreWebView2ControllerCompletedHandler;
    let env2 = env.clone();
    let handler = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
        move |hr, controller| {
            let res = (|| -> Result<(), String> {
                hr.map_err(|e| format!("controller creation failed: {e}"))?;
                let controller = match controller {
                    Some(c) => c,
                    None => {
                        take_done(&done, Err("controller creation returned none".into()));
                        return Ok(());
                    }
                };
                unsafe { controller.SetBounds(bounds) }.map_err(|e| e.to_string())?;
                on_controller(controller)
            })();
            if let Err(e) = res {
                take_done(&done, Err(e));
            }
            Ok(())
        },
    ));
    unsafe { env2.CreateCoreWebView2Controller(hwnd, &handler) }
        .map_err(|e| format!("CreateController invoke failed: {e}"))?;
    Ok(())
}

/// Register NavigationStarting / NavigationCompleted handlers DIRECTLY on a
/// core (called with the pane's own core on the main thread - no dispatch).
/// Logs every transition to logs/browser.log, emits `browser:navigated` on
/// START (the frontend's address-bar/history feed) and
/// `browser:load-completed` on success (the spinner's ground truth), and
/// re-installs the pushState hook + visual overlay after every navigation.
#[cfg(windows)]
fn attach_core_listeners(
    app: &AppHandle,
    label: &str,
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use webview2_com::NavigationCompletedEventHandler;
    use webview2_com::NavigationStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationCompletedEventArgs;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventArgs;

    // label = "browser-{pane_id}-tab-{tab_id}"
    let (pane_id, tab_id) = label
        .strip_prefix("browser-")
        .and_then(|rest| rest.split_once("-tab-"))
        .map(|(p, t)| (p.to_string(), t.to_string()))
        .unwrap_or_default();

    let app_start = app.clone();
    let label_start = label.to_string();
    let pane_start = pane_id.clone();
    let tab_start = tab_id.clone();
    let webviews_start = app.state::<BrowserState>().0.webviews.clone();
    let start_handler = NavigationStartingEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2NavigationStartingEventArgs>| {
            if let Some(args) = args {
                let mut pw = windows::core::PWSTR::null();
                if unsafe { args.Uri(&mut pw) }.is_ok() {
                    use webview2_com::take_pwstr;
                    let uri = take_pwstr(pw);
                    browser_log(&app_start, &format!("nav START label={label_start} uri={uri}"));
                    let _ = app_start.emit(
                        "browser:navigated",
                        BrowserNavigatedEvent {
                            pane_id: pane_start.clone(),
                            tab_id: tab_start.clone(),
                            url: uri.clone(),
                        },
                    );
                    // Re-install the pushState hook + visual overlay on the
                    // new document (escalating schedule; both are idempotent).
                    let pid = pane_start.clone();
                    let tid = tab_start.clone();
                    let map = webviews_start.clone();
                    let app2 = app_start.clone();
                    std::thread::spawn(move || {
                        let mut waited = 0u64;
                        for target in [0u64, 150, 400, 900, 1800, 3500, 5000u64] {
                            if target > waited {
                                std::thread::sleep(std::time::Duration::from_millis(
                                    target - waited,
                                ));
                                waited = target;
                            }
                            let lbl = format!("browser-{pid}-tab-{tid}");
                            let js =
                                format!("{}{}", pushstate_injection_js(&pid, &tid), BRIDGE_OVERLAY_JS);
                            let app3 = app2.clone();
                            let map2 = map.clone();
                            let lbl2 = lbl.clone();
                            let js2 = js.clone();
                            let _ = app3.run_on_main_thread(move || {
                                if let Some(pane) = map2.lock().get(&lbl2) {
                                    use webview2_com::ExecuteScriptCompletedHandler;
                                    let js_h = windows::core::HSTRING::from(js2);
                                    let handler = ExecuteScriptCompletedHandler::create(Box::new(
                                        |_, _| Ok(()),
                                    ));
                                    let _ =
                                        unsafe { pane.core.0.ExecuteScript(&js_h, &handler) };
                                }
                            });
                        }
                    });
                }
            }
            Ok(())
        },
    ));
    let mut start_token = 0i64;
    let _ = unsafe { core.add_NavigationStarting(&start_handler, &mut start_token) };

    let app_complete = app.clone();
    let label_complete = label.to_string();
    let complete_handler = NavigationCompletedEventHandler::create(Box::new(
        move |_sender, args: Option<ICoreWebView2NavigationCompletedEventArgs>| {
            if let Some(args) = args {
                let mut success = windows::core::BOOL::default();
                let _ = unsafe { args.IsSuccess(&mut success) };
                let mut err = webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS::default();
                let _ = unsafe { args.WebErrorStatus(&mut err) };
                browser_log(
                    &app_complete,
                    &format!(
                        "nav COMPLETE label={label_complete} success={} error={}",
                        success.as_bool(),
                        err.0
                    ),
                );
                if success.as_bool() {
                    let _ = app_complete.emit("browser:load-completed", label_complete.clone());
                }
            }
            Ok(())
        },
    ));
    let mut complete_token = 0i64;
    let _ = unsafe { core.add_NavigationCompleted(&complete_handler, &mut complete_token) };
}

'''

assert anchor in src, "anchor missing"
src = src.replace(anchor, helpers + anchor, 1)
io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("helpers ok")
