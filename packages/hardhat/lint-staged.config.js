
module.exports = {
  'contracts/**/*.sol': () => 'npm run lint:contract --noEmit',
  'test/**/*.{js,jsx,ts,tsx,json,css,scss,md}': (filenames) => `prettier --write ${filenames.join(' ')}`,
}

