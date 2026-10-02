
const Simulator = require('./lib');
const sim = new Simulator();

sim.login ("alice", "alice123");
sim.switch('alice');

const r1 = await sim.exec(`seqs list"`);

// seqId: 'bceba027-6878-4224-89cf-2ef97298dda8',
// spaceId: '684b7656-33c0-46b8-a76c-4af7fb227524'

const r2 = await sim.exec(`ballots create --title="Test Vote para la secuencia" --space=684b7656-33c0-46b8-a76c-4af7fb227524 --option="A" --option="B"`)

// ballotId: 9e51e254-087c-401c-9122-902d1ebdbbc2

const r3 = await sim.exec(`seqs add-ballot --id="bceba027-6878-4224-89cf-2ef97298dda8" --ballot="9e51e254-087c-401c-9122-902d1ebdbbc2"`);





