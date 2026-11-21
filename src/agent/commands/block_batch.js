// Batch block placing/breaking used by !placeBlocks, !fillBlocks, !breakBlocks and !clearArea.
import * as skills from '../library/skills.js';
import * as world from '../library/world.js';
import Vec3 from 'vec3';

export const MAX_BATCH_BLOCKS = 256;
const MAX_LISTED_PER_REASON = 4; // action output is cut at 500 chars, keep the summary short

/**
 * Parse "x,y,z;x,y,z" into [[x,y,z], ...]. Also accepts the "(x,y,z) (x,y,z)" format printed by !scanBlocks.
 * @returns {number[][] | string} positions, or an error message for the model
 */
export function parsePositions(str) {
    const seen = new Set();
    const positions = [];
    for (const m of str.matchAll(/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/g)) {
        const key = `${m[1]},${m[2]},${m[3]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        positions.push([Number(m[1]), Number(m[2]), Number(m[3])]);
    }
    if (positions.length === 0)
        return 'Not done: no coordinates found. Use the format "x,y,z;x,y,z;...".';
    if (positions.length > MAX_BATCH_BLOCKS)
        return `Not done: ${positions.length} positions given, max is ${MAX_BATCH_BLOCKS} per call. Split it into several calls.`;
    return positions;
}

/**
 * All positions in the box between two corners, inclusive.
 * @returns {number[][] | string} positions, or an error message for the model
 */
export function boxPositions(x1, y1, z1, x2, y2, z2) {
    const [minX, maxX] = [Math.min(x1, x2), Math.max(x1, x2)];
    const [minY, maxY] = [Math.min(y1, y2), Math.max(y1, y2)];
    const [minZ, maxZ] = [Math.min(z1, z2), Math.max(z1, z2)];
    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (volume > MAX_BATCH_BLOCKS)
        return `Not done: the box has ${volume} blocks, max is ${MAX_BATCH_BLOCKS} per call. Split it into smaller boxes.`;
    const positions = [];
    for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++)
            for (let z = minZ; z <= maxZ; z++)
                positions.push([x, y, z]);
    return positions;
}

// Run a skill while swallowing its per-block log lines (they would blow the 500-char output limit).
// Returns [result, captured log text].
async function quietly(bot, fn) {
    const saved = bot.output;
    bot.output = '';
    let result = false;
    try {
        result = await fn();
    } catch (err) {
        bot.output += `error: ${err.message}`;
    }
    const logs = bot.output;
    bot.output = saved;
    return [result, logs];
}

function shortReason(logs) {
    const l = logs.toLowerCase();
    if (l.includes('nothing to place on')) return 'nothing to build off';
    if (l.includes("don't have any")) return 'no items';
    if (l.includes('right tools')) return 'need a better tool';
    if (l.includes('in the way')) return 'block in the way';
    const firstLine = logs.trim().split('\n')[0] || 'failed';
    return firstLine.length > 60 ? firstLine.slice(0, 60) + '...' : firstLine;
}

function summarize(head, failures) {
    let res = head;
    const byReason = new Map();
    for (const [key, reason] of failures) {
        if (!byReason.has(reason)) byReason.set(reason, []);
        byReason.get(reason).push(key);
    }
    for (const [reason, keys] of byReason) {
        const shown = keys.slice(0, MAX_LISTED_PER_REASON).map(k => `(${k})`).join(' ');
        const more = keys.length > MAX_LISTED_PER_REASON ? ` +${keys.length - MAX_LISTED_PER_REASON} more` : '';
        res += `\n- ${keys.length} ${reason}: ${shown}${more}`;
    }
    return res;
}

function distanceTo(bot, [x, y, z]) {
    return bot.entity.position.distanceTo(new Vec3(x + 0.5, y + 0.5, z + 0.5));
}

function needsInventoryItems(bot) {
    return !bot.modes.isOn('cheat') && bot.game.gameMode !== 'creative';
}

function itemCount(bot, blockType) {
    let item = blockType === 'redstone_wire' ? 'redstone' : blockType;
    return world.getInventoryCounts(bot)[item] || 0;
}

/**
 * Place blockType at every position. Goes bottom-up, nearest first, and keeps retrying blocks that had
 * nothing to build off while other placements make progress. Never breaks existing blocks.
 * Logs one short summary.
 */
export async function placeBatch(bot, blockType, positions, replaceable) {
    const total = positions.length;
    let todo = positions.slice().sort((a, b) => a[1] - b[1] || distanceTo(bot, a) - distanceTo(bot, b));
    let placed = 0, already = 0;
    const failures = new Map(); // "x,y,z" -> reason
    let stopped = null;

    let progress = true;
    while (todo.length > 0 && progress && !stopped) {
        progress = false;
        const retry = [];
        for (const p of todo) {
            const key = p.join(',');
            if (bot.interrupt_code) { stopped = 'interrupted'; break; }
            const block = bot.blockAt(new Vec3(...p));
            if (!block) { failures.set(key, 'not loaded'); continue; }
            if (block.name === blockType) { already++; failures.delete(key); continue; }
            if (!replaceable.includes(block.name)) { failures.set(key, `${block.name} in the way`); continue; }
            if (needsInventoryItems(bot) && itemCount(bot, blockType) === 0) { stopped = `ran out of ${blockType}`; break; }

            const [ok, logs] = await quietly(bot, () => skills.placeBlock(bot, blockType, ...p));
            if (ok) {
                placed++;
                progress = true;
                failures.delete(key);
            } else {
                const reason = shortReason(logs);
                failures.set(key, reason);
                if (reason === 'nothing to build off') retry.push(p); // may work once neighbors are placed
            }
        }
        todo = retry;
    }

    // whatever is left unplaced when we stopped early
    if (stopped) {
        for (const p of positions) {
            const key = p.join(',');
            const block = bot.blockAt(new Vec3(...p));
            if (block && block.name !== blockType && !failures.has(key)) failures.set(key, 'not attempted');
        }
    }

    let head = `Placed ${placed}/${total} ${blockType}`;
    if (already) head += `, ${already} were already ${blockType}`;
    if (stopped) head += `. Stopped: ${stopped}`;
    head += '.';
    skills.log(bot, summarize(head, failures));
    return placed;
}

/**
 * Break the block at every position, top-down, nearest first. Air and liquids are skipped.
 * Logs one short summary.
 */
export async function breakBatch(bot, positions) {
    const todo = positions.slice().sort((a, b) => b[1] - a[1] || distanceTo(bot, a) - distanceTo(bot, b));
    let broken = 0, empty = 0;
    const failures = new Map();
    let stopped = null;

    for (const p of todo) {
        const key = p.join(',');
        if (bot.interrupt_code) { stopped = 'interrupted'; break; }
        const block = bot.blockAt(new Vec3(...p));
        if (!block) { failures.set(key, 'not loaded'); continue; }
        if (['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name)) { empty++; continue; }

        const [ok, logs] = await quietly(bot, () => skills.breakBlockAt(bot, ...p));
        if (ok) broken++;
        else failures.set(key, shortReason(logs));
    }
    if (stopped) {
        for (const p of todo) {
            const key = p.join(',');
            const block = bot.blockAt(new Vec3(...p));
            if (block && !['air', 'cave_air', 'void_air', 'water', 'lava'].includes(block.name) && !failures.has(key))
                failures.set(key, 'not attempted');
        }
    }

    let head = `Broke ${broken}/${positions.length - empty} blocks`;
    if (empty) head += ` (${empty} positions were already empty)`;
    if (stopped) head += `. Stopped: ${stopped}`;
    head += '.';
    skills.log(bot, summarize(head, failures));
    return broken;
}
