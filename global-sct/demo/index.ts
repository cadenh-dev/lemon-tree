if (process.argv.length !== 2) {
  console.error('The demo accepts no arguments. Supply SCT_DEMO_TOKEN through the project environment.')
  process.exitCode = 1
} else if (!Object.hasOwn(process.env, 'SCT_DEMO_TOKEN')) {
  console.error('Save SCT_DEMO_TOKEN in the registered project, then launch the demo with sct run.')
  process.exitCode = 1
} else {
  console.log('The demo received SCT_DEMO_TOKEN through its environment. Its value stays private.')
}
