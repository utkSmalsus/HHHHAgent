import 'dotenv/config';
import { writeFileSync } from 'fs';
import { scrollPayloads } from '../src/services/qdrantScroll.js';

const meetings = await scrollPayloads({ types: ['meeting'], limit: 5000 });
// Use the Stefan meeting's real, already ground-truthed summary/content as the "uploaded transcript"
// — this is REAL data pulled from the KB, not fabricated, satisfying "derive from available data".
const m = meetings.find((x) => x.title === 'Meeting with Stefan');
if (!m) {
  console.error('Meeting with Stefan not found');
  process.exit(1);
}
writeFileSync('./qa/test-transcript.txt', m.text);
console.log('Wrote qa/test-transcript.txt —', m.text.length, 'chars');
console.log('First 300 chars:', m.text.slice(0, 300));
