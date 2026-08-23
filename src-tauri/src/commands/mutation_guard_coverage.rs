#[cfg(test)]
mod tests {
    use std::collections::{BTreeSet, HashMap};

    use crate::error::AppError;
    use crate::state::AppState;

    #[derive(Clone, Copy, Debug, Eq, PartialEq)]
    enum CommandClass {
        Mutation,
        ReadOnly,
        SaveFlow,
    }

    fn parse_registered_commands(lib_source: &str) -> Vec<String> {
        let marker = "tauri::generate_handler![";
        let start = lib_source
            .find(marker)
            .expect("generate_handler list must exist")
            + marker.len();
        let rest = &lib_source[start..];
        let end = rest
            .find("])")
            .expect("generate_handler list must terminate with ])");
        rest[..end]
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(|line| line.trim_end_matches(','))
            .map(str::to_string)
            .collect()
    }

    fn command_classes() -> HashMap<&'static str, CommandClass> {
        HashMap::from([
            ("commands::data_commands::import_file", CommandClass::Mutation),
            ("commands::data_commands::list_datasets", CommandClass::ReadOnly),
            ("commands::data_commands::delete_dataset", CommandClass::Mutation),
            ("commands::data_commands::query_table", CommandClass::ReadOnly),
            (
                "commands::data_commands::query_table_window",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::get_dataset_generation",
                CommandClass::ReadOnly,
            ),
            ("commands::data_commands::locate_table_row", CommandClass::ReadOnly),
            (
                "commands::data_commands::query_table_filter_values",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::execute_sql_query",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::create_table_from_sql_query",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::create_table", CommandClass::Mutation),
            ("commands::data_commands::add_row", CommandClass::Mutation),
            ("commands::data_commands::add_rows", CommandClass::Mutation),
            (
                "commands::data_commands::apply_added_rows",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::update_cell", CommandClass::Mutation),
            ("commands::data_commands::clear_cells", CommandClass::Mutation),
            ("commands::data_commands::update_cells", CommandClass::Mutation),
            ("commands::data_commands::delete_row", CommandClass::Mutation),
            ("commands::data_commands::delete_rows", CommandClass::Mutation),
            (
                "commands::data_commands::delete_rows_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::delete_columns_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::alter_column_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::alter_columns_type_with_change_set",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::rename_dataset", CommandClass::Mutation),
            ("commands::data_commands::add_column", CommandClass::Mutation),
            (
                "commands::data_commands::add_column_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::add_columns_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::insert_column_at",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::reorder_column", CommandClass::Mutation),
            (
                "commands::data_commands::reorder_column_if_generation",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::delete_column", CommandClass::Mutation),
            ("commands::data_commands::rename_column", CommandClass::Mutation),
            (
                "commands::data_commands::change_column_type",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::paste_at_position",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::paste_at_position_with_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::apply_table_change_set",
                CommandClass::Mutation,
            ),
            (
                "commands::data_commands::drop_table_change_set",
                CommandClass::Mutation,
            ),
            ("commands::data_commands::restore_snapshot", CommandClass::Mutation),
            (
                "commands::data_commands::get_column_display_props",
                CommandClass::ReadOnly,
            ),
            (
                "commands::data_commands::set_column_display_props",
                CommandClass::Mutation,
            ),
            ("commands::stats_commands::get_column_stats", CommandClass::ReadOnly),
            (
                "commands::stats_commands::get_descriptive_stats",
                CommandClass::ReadOnly,
            ),
            ("commands::tabulate_commands::tabulate", CommandClass::ReadOnly),
            ("commands::io_commands::export_csv", CommandClass::ReadOnly),
            ("commands::io_commands::import_sqlite", CommandClass::Mutation),
            ("commands::io_commands::export_sqlite", CommandClass::ReadOnly),
            ("commands::io_commands::export_csv_zip", CommandClass::ReadOnly),
            (
                "commands::io_commands::export_csv_zip_subset",
                CommandClass::ReadOnly,
            ),
            (
                "commands::io_commands::export_sqlite_subset",
                CommandClass::ReadOnly,
            ),
            (
                "commands::history_commands::capture_project_snapshot",
                CommandClass::ReadOnly,
            ),
            (
                "commands::history_commands::restore_project_snapshot",
                CommandClass::Mutation,
            ),
            ("commands::project_commands::init_project", CommandClass::Mutation),
            (
                "commands::project_commands::create_project",
                CommandClass::Mutation,
            ),
            ("commands::project_commands::open_project", CommandClass::Mutation),
            ("commands::project_commands::save_project", CommandClass::SaveFlow),
            (
                "commands::project_commands::get_current_project",
                CommandClass::ReadOnly,
            ),
            ("commands::project_commands::export_table", CommandClass::ReadOnly),
            (
                "commands::project_commands::export_tables_sptb_zip",
                CommandClass::ReadOnly,
            ),
            ("commands::project_commands::import_table", CommandClass::Mutation),
            ("commands::project_commands::export_graph", CommandClass::ReadOnly),
            ("commands::project_commands::import_graph", CommandClass::ReadOnly),
            ("commands::table_commands::get_columns", CommandClass::ReadOnly),
            ("commands::table_commands::sort_table", CommandClass::Mutation),
            ("commands::table_commands::subset_table", CommandClass::Mutation),
            (
                "commands::table_commands::transpose_table",
                CommandClass::Mutation,
            ),
            ("commands::table_commands::stack_table", CommandClass::Mutation),
            ("commands::table_commands::split_table", CommandClass::Mutation),
            ("commands::table_commands::summary_table", CommandClass::Mutation),
            ("commands::table_commands::join_tables", CommandClass::Mutation),
            ("commands::table_commands::update_table", CommandClass::Mutation),
            (
                "commands::table_commands::concatenate_tables",
                CommandClass::Mutation,
            ),
        ])
    }

    fn functions_requiring_mutation_permit() -> [(&'static str, &'static str); 47] {
        [
            ("data_commands.rs", "import_file"),
            ("data_commands.rs", "delete_dataset"),
            ("data_commands.rs", "create_table_from_sql_query"),
            ("data_commands.rs", "create_table"),
            ("data_commands.rs", "add_row"),
            ("data_commands.rs", "add_rows"),
            ("data_commands.rs", "apply_added_rows"),
            ("data_commands.rs", "update_cell"),
            ("data_commands.rs", "clear_cells"),
            ("data_commands.rs", "update_cells"),
            ("data_commands.rs", "delete_row"),
            ("data_commands.rs", "delete_rows"),
            ("data_commands.rs", "delete_rows_with_change_set"),
            ("data_commands.rs", "delete_columns_with_change_set"),
            ("data_commands.rs", "alter_column_with_change_set"),
            ("data_commands.rs", "alter_columns_type_with_change_set"),
            ("data_commands.rs", "rename_dataset"),
            ("data_commands.rs", "add_column"),
            ("data_commands.rs", "add_column_with_change_set"),
            ("data_commands.rs", "add_columns_with_change_set"),
            ("data_commands.rs", "insert_column_at"),
            ("data_commands.rs", "reorder_column"),
            ("data_commands.rs", "reorder_column_if_generation"),
            ("data_commands.rs", "delete_column"),
            ("data_commands.rs", "rename_column"),
            ("data_commands.rs", "change_column_type"),
            ("data_commands.rs", "paste_at_position"),
            ("data_commands.rs", "paste_at_position_with_change_set"),
            ("data_commands.rs", "apply_table_change_set"),
            ("data_commands.rs", "drop_table_change_set"),
            ("data_commands.rs", "restore_snapshot"),
            ("data_commands.rs", "set_column_display_props"),
            ("table_commands.rs", "sort_table"),
            ("table_commands.rs", "subset_table"),
            ("table_commands.rs", "transpose_table"),
            ("table_commands.rs", "stack_table"),
            ("table_commands.rs", "split_table"),
            ("table_commands.rs", "summary_table"),
            ("table_commands.rs", "join_tables"),
            ("table_commands.rs", "update_table"),
            ("table_commands.rs", "concatenate_tables"),
            ("io_commands.rs", "import_sqlite"),
            ("history_commands.rs", "restore_project_snapshot"),
            ("project_commands.rs", "init_project"),
            ("project_commands.rs", "create_project"),
            ("project_commands.rs", "open_project"),
            ("project_commands.rs", "import_table"),
        ]
    }

    fn assert_has_permit_statement(module_source: &str, function_name: &str, file_name: &str) {
        let function_header = format!("pub fn {function_name}(");
        let function_start = module_source.find(&function_header).unwrap_or_else(|| {
            panic!("{function_name} must exist in {file_name} for mutation coverage")
        });
        let function_body = &module_source[function_start..];
        let function_end = function_body
            .find("\n#[tauri::command")
            .unwrap_or(function_body.len());
        let function_slice = &function_body[..function_end];

        assert!(
            function_slice.contains("let _permit = state.save_coordinator.mutation_permit()?;"),
            "{file_name}::{function_name} must acquire mutation permit at command entry"
        );
    }

    #[test]
    fn command_classification_covers_every_registered_handler() {
        let lib_source = include_str!("../lib.rs");
        let registered = parse_registered_commands(lib_source);
        let classifications = command_classes();

        let registered_set: BTreeSet<&str> = registered.iter().map(String::as_str).collect();
        let classified_set: BTreeSet<&str> = classifications.keys().copied().collect();

        assert_eq!(
            registered_set, classified_set,
            "classification table must enumerate every command in generate_handler and only those commands"
        );
    }

    #[test]
    fn mutating_commands_in_guarded_families_require_permit_acquisition() {
        let data_source = include_str!("data_commands.rs");
        let table_source = include_str!("table_commands.rs");
        let io_source = include_str!("io_commands.rs");
        let history_source = include_str!("history_commands.rs");
        let project_source = include_str!("project_commands.rs");

        for (file_name, function_name) in functions_requiring_mutation_permit() {
            let source = match file_name {
                "data_commands.rs" => data_source,
                "table_commands.rs" => table_source,
                "io_commands.rs" => io_source,
                "history_commands.rs" => history_source,
                "project_commands.rs" => project_source,
                _ => panic!("unexpected file in permit coverage list: {file_name}"),
            };

            assert_has_permit_statement(source, function_name, file_name);
        }
    }

    #[test]
    fn save_project_remains_outside_mutation_permit_path() {
        let source = include_str!("project_commands.rs");
        let save_start = source
            .find("pub async fn save_project(")
            .expect("save_project command must exist");
        let save_body = &source[save_start..];
        let save_end = save_body.find("\n#[tauri::command").unwrap_or(save_body.len());
        let save_slice = &save_body[..save_end];

        assert!(
            !save_slice.contains("mutation_permit"),
            "save_project must not acquire a mutation permit; it is guarded by SaveGuard"
        );
    }

    #[test]
    fn save_blocks_mutation_permit_across_all_guarded_command_families() {
        let state = AppState::new().expect("app state should initialize");
        let _save_guard = state
            .save_coordinator
            .begin_save()
            .expect("save guard should start");

        let data = crate::commands::data_commands::acquire_mutation_permit(&state)
            .expect_err("data family mutation must be blocked while save is active");
        assert!(matches!(data, AppError::ReadOnly(_)));

        let table = crate::commands::table_commands::acquire_mutation_permit(&state)
            .expect_err("table family mutation must be blocked while save is active");
        assert!(matches!(table, AppError::ReadOnly(_)));

        let io = crate::commands::io_commands::acquire_mutation_permit(&state)
            .expect_err("io family mutation must be blocked while save is active");
        assert!(matches!(io, AppError::ReadOnly(_)));

        let history = crate::commands::history_commands::acquire_mutation_permit(&state)
            .expect_err("history family mutation must be blocked while save is active");
        assert!(matches!(history, AppError::ReadOnly(_)));

        let project = crate::commands::project_commands::acquire_mutation_permit(&state)
            .expect_err("project family mutation must be blocked while save is active");
        assert!(matches!(project, AppError::ReadOnly(_)));
    }

    #[test]
    fn save_does_not_block_basic_backend_reads() {
        let state = AppState::new().expect("app state should initialize");
        let _save_guard = state
            .save_coordinator
            .begin_save()
            .expect("save guard should start");

        let datasets = state
            .db
            .lock()
            .expect("db lock should be available")
            .list_datasets()
            .expect("list_datasets should stay available during save");
        assert!(datasets.is_empty());

        let project = state
            .project
            .read()
            .expect("project lock should be available");
        assert!(project.is_none());
    }
}
