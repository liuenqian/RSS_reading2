mod commands;
mod db;
mod db_migrations;
mod models;
mod services;

use commands::{
    briefing_cmd, entry_cmd, feed_cmd, fetch_cmd, nature_download_cmd, opml_cmd, paper_chat_cmd,
    paper_graph_cmd, pmc_gallery_cmd, pubmed_cmd, pubmed_conversion_cmd, pubmed_search_cmd,
    reading_cmd, sci_review_cmd, sci_skill_cmd, screening_cmd, settings_cmd, translate_cmd,
    tray_cmd, update_cmd,
};
use services::scheduler;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tracing_subscriber::{fmt, EnvFilter};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("cento=info,cento_lib=info")),
        )
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");

            let db_state =
                db::initialize(app_data_dir).map_err(|e| Box::new(std::io::Error::other(e)))?;

            app.manage(db_state);
            app.manage(paper_chat_cmd::PaperChatRequestState::default());

            // ── macOS menu-bar tray icon ──
            let show_item = MenuItemBuilder::with_id("tray-show", "打开 RSS Reading").build(app)?;
            let quit_item = MenuItemBuilder::with_id("tray-quit", "退出").build(app)?;
            let tray_menu = MenuBuilder::new(app)
                .items(&[&show_item, &quit_item])
                .build()?;

            // Use a dedicated monochrome silhouette as the menu-bar icon. The
            // square app icon, even with `icon_as_template`, produces a flat
            // square on the menu bar because macOS only looks at alpha for
            // template images and the full-color art has no alpha holes.
            // `tray-icon@2x.png` is a 44×44 PNG of just the "C" arc.
            //
            // `icon_as_template(true)` is a macOS-only concept (template
            // images automatically invert for dark menu bar). On Windows the
            // tray icon stays full-color in the system tray, so we skip it
            // there.
            let tray_builder = TrayIconBuilder::with_id("cento-tray")
                .icon(tauri::include_image!("icons/tray-icon@2x.png"));

            #[cfg(target_os = "macos")]
            let tray_builder = tray_builder.icon_as_template(true);

            let _ = tray_builder
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "tray-show" => focus_main_window(app),
                    "tray-quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        focus_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Hide-to-tray: intercept the red close button so the process keeps
            // running (and the scheduler keeps ticking) instead of quitting.
            if let Some(window) = app.get_webview_window("main") {
                let win = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            // Start the background refresh scheduler + the weekly update
            // checker. Both run independently on Tauri's async runtime.
            scheduler::start(app.handle().clone());
            scheduler::start_update_checker(app.handle().clone());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            briefing_cmd::list_briefings,
            briefing_cmd::generate_briefing,
            briefing_cmd::delete_briefing,
            entry_cmd::add_entry_tag,
            entry_cmd::fetch_abstract,
            entry_cmd::fetch_affiliation,
            entry_cmd::fetch_entry_authors,
            entry_cmd::fetch_entry_pdf,
            entry_cmd::fetch_entry_identifiers,
            entry_cmd::resolve_entry_pdf_url,
            entry_cmd::ensure_free_fulltext_status,
            entry_cmd::get_reading_stats,
            entry_cmd::generate_stats_flavor_pool,
            entry_cmd::analyze_word_frequency,
            entry_cmd::translate_word_frequency_terms,
            entry_cmd::list_entries,
            entry_cmd::remove_entry_tag,
            entry_cmd::search_entries,
            entry_cmd::set_entry_read,
            entry_cmd::set_entry_screening_status,
            screening_cmd::list_starred_entry_ids,
            screening_cmd::open_screening_window,
            screening_cmd::migrate_legacy_starred_ids,
            screening_cmd::set_entry_starred,
            screening_cmd::bulk_set_entries_starred,
            screening_cmd::set_feed_screening_state,
            screening_cmd::list_feed_screening_states,
            screening_cmd::query_screening_scope,
            screening_cmd::resolve_screening_selection,
            screening_cmd::get_screening_table_preferences,
            screening_cmd::save_screening_table_preferences,
            screening_cmd::export_screening_xlsx,
            screening_cmd::preview_screening_xlsx_import,
            screening_cmd::apply_screening_xlsx_import,
            feed_cmd::add_feed,
            feed_cmd::list_feeds,
            feed_cmd::delete_feed,
            feed_cmd::rename_feed,
            feed_cmd::update_feed,
            feed_cmd::set_feed_interval,
            feed_cmd::set_feed_notify,
            fetch_cmd::fetch_all_feeds,
            fetch_cmd::fetch_feed,
            nature_download_cmd::download_papers_with_nature,
            opml_cmd::export_opml,
            opml_cmd::import_opml,
            paper_chat_cmd::list_paper_chat_messages,
            paper_chat_cmd::clear_paper_chat,
            paper_chat_cmd::import_paper_chat_attachments,
            paper_chat_cmd::cancel_paper_chat,
            paper_chat_cmd::ask_paper_chat,
            paper_chat_cmd::suggest_pubmed_screening,
            paper_graph_cmd::get_paper_graph,
            pmc_gallery_cmd::list_pmc_gallery_searches,
            pmc_gallery_cmd::create_pmc_gallery_search,
            pmc_gallery_cmd::update_pmc_gallery_search,
            pmc_gallery_cmd::rename_pmc_gallery_search,
            pmc_gallery_cmd::delete_pmc_gallery_search,
            pmc_gallery_cmd::load_pmc_gallery_cache,
            pmc_gallery_cmd::list_pmc_gallery_journals,
            pmc_gallery_cmd::preview_pmc_gallery_search,
            pmc_gallery_cmd::search_pmc_gallery,
            pubmed_cmd::build_pubmed_rss_url,
            pubmed_cmd::build_pubmed_author_query,
            pubmed_cmd::build_pubmed_author_expansion_queries,
            pubmed_cmd::natural_to_pubmed_query,
            pubmed_cmd::generate_sci_review_search_strategy,
            sci_review_cmd::run_sci_review_stage,
            sci_review_cmd::recommend_sci_review_journals,
            sci_review_cmd::write_sci_review_section,
            sci_review_cmd::confirm_sci_review_writing_quality_gates,
            sci_skill_cmd::list_sci_skill_specs,
            sci_skill_cmd::get_sci_skill_spec,
            pubmed_conversion_cmd::convert_pubmed_feed_to_search,
            pubmed_conversion_cmd::convert_pubmed_search_to_feed,
            pubmed_search_cmd::preview_pubmed_search,
            pubmed_search_cmd::assess_pubmed_search_preview,
            pubmed_search_cmd::assess_pubmed_author_preview,
            pubmed_search_cmd::create_pubmed_search,
            pubmed_search_cmd::list_pubmed_searches,
            pubmed_search_cmd::get_pubmed_search,
            pubmed_search_cmd::clone_pubmed_search,
            pubmed_search_cmd::rename_pubmed_search,
            pubmed_search_cmd::update_pubmed_search,
            pubmed_search_cmd::delete_pubmed_search,
            pubmed_search_cmd::run_pubmed_search,
            pubmed_search_cmd::resume_pubmed_search_run,
            pubmed_search_cmd::cancel_pubmed_search_run,
            pubmed_search_cmd::list_pubmed_search_entries,
            pubmed_search_cmd::set_pubmed_screening_status,
            pubmed_search_cmd::bulk_set_pubmed_screening_status,
            pubmed_search_cmd::get_pubmed_author_identity_state,
            pubmed_search_cmd::save_pubmed_author_identity_state,
            pubmed_search_cmd::list_kept_pubmed_entries,
            pubmed_search_cmd::export_pubmed_entries,
            pubmed_search_cmd::export_google_translate_xlsx,
            pubmed_search_cmd::preview_google_translate_import,
            pubmed_search_cmd::apply_google_translate_import,
            pubmed_search_cmd::apply_pubmed_screening_suggestions,
            reading_cmd::get_reading_profiles,
            reading_cmd::import_reading_skill,
            reading_cmd::save_reading_profiles,
            reading_cmd::list_reading_notes,
            reading_cmd::delete_reading_note,
            reading_cmd::update_reading_note,
            reading_cmd::append_paper_chat_to_note,
            reading_cmd::generate_reading_note,
            settings_cmd::get_settings,
            settings_cmd::get_provider_settings,
            settings_cmd::list_ai_models,
            settings_cmd::get_ai_model,
            settings_cmd::save_ai_model,
            settings_cmd::activate_ai_model,
            settings_cmd::delete_ai_model,
            settings_cmd::list_api_token_profiles,
            settings_cmd::upsert_api_token_profile,
            settings_cmd::activate_api_token_profile,
            settings_cmd::delete_api_token_profile,
            settings_cmd::save_settings,
            settings_cmd::test_connection,
            settings_cmd::fetch_deepseek_balance,
            translate_cmd::translate_summary,
            translate_cmd::translate_entry_title,
            translate_cmd::translate_entry_summary,
            translate_cmd::translate_entry_missing,
            translate_cmd::open_url,
            translate_cmd::get_cost_summary,
            tray_cmd::update_tray_unread,
            tray_cmd::set_tray_visible,
            tray_cmd::send_test_notification,
            update_cmd::check_for_update,
            update_cmd::download_update_installer,
            update_cmd::get_app_version,
            update_cmd::get_update_prefs,
            update_cmd::open_downloaded_update,
            update_cmd::reveal_downloaded_update,
            update_cmd::set_update_auto_check,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // macOS: 点击 Dock 图标时（窗口已被隐藏到托盘），
            // 系统会发 Reopen 事件 —— 需要手动把主窗口恢复出来。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                if !has_visible_windows {
                    focus_main_window(app_handle);
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app_handle, event);
            }
        });
}

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
