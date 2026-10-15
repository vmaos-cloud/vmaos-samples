import { clientFromEnv, reportError } from './client.mjs';
import { queryBoards } from './boards.mjs';

try {
  for await (const page of queryBoards(clientFromEnv())) {
    console.log(JSON.stringify(page, null, 2));
  }
} catch (error) { reportError(error); }
