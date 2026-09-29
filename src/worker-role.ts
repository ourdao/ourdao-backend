// Imported first by src/worker.ts. ES imports evaluate in order, so this runs
// before src/config.ts and src/db/index.ts read the environment and create
// the pool — letting the worker's connections carry their own
// `application_name` (issue #196). An operator-set OURDAO_PROCESS_ROLE or
// DB_APPLICATION_NAME still wins.
process.env.OURDAO_PROCESS_ROLE ||= 'worker'
