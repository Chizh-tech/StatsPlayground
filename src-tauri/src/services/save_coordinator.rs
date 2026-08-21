use std::sync::{Condvar, Mutex};

use crate::error::AppError;

#[derive(Debug, Default)]
struct CoordinatorState {
    saving: bool,
    save_waiting: bool,
    active_mutations: usize,
}

#[derive(Debug, Default)]
pub struct SaveCoordinator {
    state: Mutex<CoordinatorState>,
    condvar: Condvar,
}

impl SaveCoordinator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mutation_permit(&self) -> Result<MutationPermit<'_>, AppError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Database("Save coordinator lock poisoned".to_string()))?;

        if state.save_waiting || state.saving {
            return Err(AppError::ReadOnly(
                "Project is read-only while a save is pending or active".to_string(),
            ));
        }

        state.active_mutations = state.active_mutations.saturating_add(1);

        Ok(MutationPermit {
            coordinator: self,
            released: false,
        })
    }

    pub fn begin_save(&self) -> Result<SaveGuard<'_>, AppError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| AppError::Database("Save coordinator lock poisoned".to_string()))?;

        if state.save_waiting || state.saving {
            return Err(AppError::Busy("Another save is already in progress".to_string()));
        }

        // Register save intent atomically before waiting so new mutation permits are blocked.
        state.save_waiting = true;

        while state.active_mutations > 0 {
            state = match self.condvar.wait(state) {
                Ok(guard) => guard,
                Err(poisoned) => {
                    let mut inner = poisoned.into_inner();
                    inner.save_waiting = false;
                    self.condvar.notify_all();
                    return Err(AppError::Database(
                        "Save coordinator lock poisoned while waiting for mutations".to_string(),
                    ));
                }
            };
        }

        state.save_waiting = false;
        state.saving = true;

        Ok(SaveGuard {
            coordinator: self,
            released: false,
        })
    }

    pub fn is_saving(&self) -> bool {
        match self.state.lock() {
            Ok(state) => state.saving || state.save_waiting,
            Err(_) => true,
        }
    }
}

#[derive(Debug)]
pub struct MutationPermit<'a> {
    coordinator: &'a SaveCoordinator,
    released: bool,
}

impl Drop for MutationPermit<'_> {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        if let Ok(mut state) = self.coordinator.state.lock() {
            if state.active_mutations > 0 {
                state.active_mutations -= 1;
            }
        }

        self.released = true;
        self.coordinator.condvar.notify_all();
    }
}

#[derive(Debug)]
pub struct SaveGuard<'a> {
    coordinator: &'a SaveCoordinator,
    released: bool,
}

impl Drop for SaveGuard<'_> {
    fn drop(&mut self) {
        if self.released {
            return;
        }

        if let Ok(mut state) = self.coordinator.state.lock() {
            state.saving = false;
            state.save_waiting = false;
        }

        self.released = true;
        self.coordinator.condvar.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;

    use crate::error::AppError;

    use super::SaveCoordinator;

    #[test]
    fn begin_save_waits_until_active_mutation_permit_drops() {
        let coordinator = Arc::new(SaveCoordinator::new());
        let permit = coordinator
            .mutation_permit()
            .expect("permit should be acquired");

        let start_barrier = Arc::new(Barrier::new(2));
        let thread_coordinator = Arc::clone(&coordinator);
        let thread_barrier = Arc::clone(&start_barrier);
        let (tx, rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            thread_barrier.wait();
            let result = thread_coordinator.begin_save();
            tx.send(result.is_ok()).expect("send result");
        });

        start_barrier.wait();
        assert!(rx.try_recv().is_err());

        drop(permit);

        assert!(rx.recv().expect("receive result"));
        handle.join().expect("join save thread");
    }

    #[test]
    fn second_save_is_rejected_as_busy() {
        let coordinator = SaveCoordinator::new();
        let save_guard = coordinator.begin_save().expect("first save starts");

        let second = coordinator.begin_save().expect_err("second save should fail");
        assert!(matches!(second, AppError::Busy(_)));

        drop(save_guard);
    }

    #[test]
    fn mutation_permit_is_rejected_while_save_intent_waits_or_save_active() {
        let coordinator = Arc::new(SaveCoordinator::new());
        let permit = coordinator
            .mutation_permit()
            .expect("initial permit should be acquired");

        let barrier = Arc::new(Barrier::new(2));
        let thread_coordinator = Arc::clone(&coordinator);
        let thread_barrier = Arc::clone(&barrier);
        let (save_started_tx, save_started_rx) = mpsc::channel();
        let (release_save_tx, release_save_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let handle = thread::spawn(move || {
            thread_barrier.wait();
            let save_result = thread_coordinator.begin_save();
            match save_result {
                Ok(_guard) => {
                    save_started_tx
                        .send(())
                        .expect("signal save started");
                    release_save_rx.recv().expect("wait to release save");
                    finished_tx.send(true).expect("send save success");
                }
                Err(_) => {
                    let _ = finished_tx.send(false);
                }
            }
        });

        barrier.wait();

        let while_waiting = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked while save waits");
        assert!(matches!(while_waiting, AppError::ReadOnly(_)));

        drop(permit);
        save_started_rx.recv().expect("save should start after drain");

        let while_saving = coordinator
            .mutation_permit()
            .expect_err("permit should be blocked while save active");
        assert!(matches!(while_saving, AppError::ReadOnly(_)));

        release_save_tx.send(()).expect("release save thread");
        assert!(finished_rx.recv().expect("receive save result"));

        handle.join().expect("join save thread");
    }

    #[test]
    fn dropping_save_guard_restores_mutation_permit_acquisition() {
        let coordinator = SaveCoordinator::new();

        {
            let _save_guard = coordinator.begin_save().expect("save starts");
            let blocked = coordinator
                .mutation_permit()
                .expect_err("permit should be blocked during save");
            assert!(matches!(blocked, AppError::ReadOnly(_)));
        }

        let permit = coordinator
            .mutation_permit()
            .expect("permit should be restored after save guard drop");
        drop(permit);
    }

    #[test]
    fn dropping_save_guard_after_failed_operation_restores_mutation_permit() {
        let coordinator = SaveCoordinator::new();

        let save_result: Result<(), AppError> = {
            let _save_guard = coordinator.begin_save().expect("save starts");
            Err(AppError::FileIO("synthetic save failure".to_string()))
        };

        assert!(save_result.is_err());

        let permit = coordinator
            .mutation_permit()
            .expect("permit should be restored after failed save path");
        drop(permit);
    }
}
