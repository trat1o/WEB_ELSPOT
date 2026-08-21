const bcrypt = require('bcryptjs');

const password = process.argv[2];
if (!password) {
  console.error('Lietošana: npm run hash-password -- "tava-parole"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nIeliec šo .env failā kā ADMIN_PASSWORD_HASH:\n');
console.log(hash);
console.log('');
