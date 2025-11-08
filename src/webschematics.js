import './lib/nbt.js';
import * as pako from './lib/pako.js';
import render from './renderer.js';

let resourcesUrl = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/1.21.10';
export default async function renderSchematic(file, parent, resources = resourcesUrl) {
    try {
        const nbtData = await getNbtData(file);
        
        // Check if the structure is what we expect
        if (!nbtData || !nbtData.value) {
            throw new Error('Invalid NBT structure: missing value property');
        }
        
        // Try to access dimensions with defensive checks
        const widthObj = nbtData.value.Width;
        const heightObj = nbtData.value.Height;
        const lengthObj = nbtData.value.Length;
        
        if (!widthObj || widthObj.value === undefined) {
            console.error('Available keys in nbtData.value:', Object.keys(nbtData.value));
            throw new Error('Invalid NBT structure: Width field missing or invalid');
        }
        if (!heightObj || heightObj.value === undefined) {
            throw new Error('Invalid NBT structure: Height field missing or invalid');
        }
        if (!lengthObj || lengthObj.value === undefined) {
            throw new Error('Invalid NBT structure: Length field missing or invalid');
        }
        
        const width = widthObj.value;
        const height = heightObj.value;
        const length = lengthObj.value;
        
        // Detect format: .schem has Palette and BlockData, .schematic has Blocks and Data
        const hasPalette = nbtData.value.Palette !== undefined;
        const hasBlocks = nbtData.value.Blocks !== undefined;
        
        let blocks;
        if (hasPalette) {
            // Sponge v3 .schem format
            blocks = getBlocksFromSchem(nbtData);
        } else if (hasBlocks) {
            // Legacy .schematic format (MCEdit/WorldEdit)
            blocks = getBlocksFromSchematic(nbtData);
        } else {
            throw new Error('Unknown schematic format: missing both Palette/BlockData and Blocks fields');
        }
        
        await render(blocks, width, height, length, parent, resources);
    } catch (error) {
        console.error('Error rendering schematic:', error);
        throw error;
    }
}

async function readFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = function (event) {
            try {
                const data = new Uint8Array(event.target.result);
                // Try to decompress - pako.inflate can handle both deflate and gzip
                // If it fails, the data might already be uncompressed
                try {
                    const decompressed = pako.inflate(data);
                    // pako.inflate returns Uint8Array, convert to ArrayBuffer for nbt.parse
                    resolve(decompressed.buffer);
                } catch (decompressError) {
                    // If decompression fails, try using the data as-is
                    // (it might already be uncompressed)
                    console.warn('Decompression failed, trying raw data:', decompressError);
                    resolve(data.buffer);
                }
            } catch (error) {
                reject(error);
            }
        };
        reader.onerror = function (error) {
            reject(error);
        };
        reader.readAsArrayBuffer(file);
    });
}

async function getNbtData(file) {
    const data = await readFile(file);
    // readFile now returns ArrayBuffer, which nbt.parse can handle directly
    
    return new Promise((resolve, reject) => {
        nbt.parse(data, function (error, data) {
            if (error) {
                console.error('NBT parse error:', error);
                reject(error);
                return;
            }
            resolve(data);
        });
    });
}

function getBlockData(palette, blockId) {
    // Iterate through each key pair in the palette values
    for (const [key, value] of Object.entries(palette)) {
        if (value.value === blockId) {
            // If the key contains a closing bracket, return only everything before the bracket
            if (key.includes("[")) {
                return {
                    name: key.substring(0, key.indexOf("[")),
                    properties: key.substring(key.indexOf("[") + 1, key.indexOf("]")).split(",")
                };
            }
            return {
                name: key,
            };
        }
    }
    return {
        name: "minecraft:air",
    };
}

// Handle Sponge v3 .schem format
function getBlocksFromSchem(nbtData) {
    // Get dimensions of the schematic
    const width = nbtData.value.Width.value;
    const height = nbtData.value.Height.value;
    const length = nbtData.value.Length.value;

    // Get the palette and block data
    const paletteObj = nbtData.value.Palette;
    const blockDataObj = nbtData.value.BlockData;
    
    if (!paletteObj || paletteObj.value === undefined) {
        throw new Error('Invalid NBT structure: Palette field missing or invalid');
    }
    if (!blockDataObj || blockDataObj.value === undefined) {
        throw new Error('Invalid NBT structure: BlockData field missing or invalid');
    }
    
    const palette = paletteObj.value;
    const blockData = blockDataObj.value;

    // Create a new 3d array
    let skippedBlocks = [];
    let blocks = [];
    for (let y = 0; y < height; y++) {
        blocks[y] = [];
        for (let x = 0; x < width; x++) {
            blocks[y][x] = [];
            for (let z = 0; z < length; z++) {
                const blockId = blockData[x + z * width + y * width * length];
                const data = getBlockData(palette, blockId);
                if (data === undefined) {
                    skippedBlocks.push(blockId);
                    continue;
                }
                blocks[y][x][z] = data;
            }
        }
    }
    if (skippedBlocks.length > 0) {
        console.warn("Failed to get block data for: " + skippedBlocks);
    }
    return blocks;
}

// Handle legacy .schematic format (MCEdit/WorldEdit)
function getBlocksFromSchematic(nbtData) {
    // Get dimensions
    const width = nbtData.value.Width.value;
    const height = nbtData.value.Height.value;
    const length = nbtData.value.Length.value;

    // Get Blocks and Data arrays
    const blocksObj = nbtData.value.Blocks;
    const dataObj = nbtData.value.Data; // Block data/metadata (optional)
    
    if (!blocksObj || blocksObj.value === undefined) {
        throw new Error('Invalid NBT structure: Blocks field missing or invalid');
    }
    
    const blocksArray = blocksObj.value;
    const dataArray = dataObj && dataObj.value ? dataObj.value : null;

    // Legacy format uses block IDs directly (0-255)
    // We need to map these to modern block names
    // This is a simplified mapping - you may need to expand this
    const legacyBlockMap = createLegacyBlockMap();
    
    let skippedBlocks = [];
    let blocks = [];
    for (let y = 0; y < height; y++) {
        blocks[y] = [];
        for (let x = 0; x < width; x++) {
            blocks[y][x] = [];
            for (let z = 0; z < length; z++) {
                const index = x + z * width + y * width * length;
                const blockId = blocksArray[index];
                const blockData = dataArray ? dataArray[index] : 0;
                
                // Convert legacy block ID to modern block name
                const blockName = legacyBlockMap[blockId] || `minecraft:unknown_${blockId}`;
                
                if (blockName.startsWith('minecraft:unknown_')) {
                    skippedBlocks.push(blockId);
                }
                
                // Create block object (legacy format doesn't have properties in the same way)
                blocks[y][x][z] = {
                    name: blockName,
                    properties: blockData > 0 ? [`data=${blockData}`] : undefined
                };
            }
        }
    }
    
    if (skippedBlocks.length > 0) {
        console.warn("Unknown block IDs in legacy format: " + [...new Set(skippedBlocks)].join(', '));
    }
    
    return blocks;
}

// Map legacy block IDs (0-255) to modern block names
// This is a basic mapping - you may need to expand this based on the Minecraft version
function createLegacyBlockMap() {
    const map = {};
    // Air
    map[0] = 'minecraft:air';
    // Common blocks - this is a simplified mapping
    // You may need to expand this based on the actual schematic's Minecraft version
    map[1] = 'minecraft:stone';
    map[2] = 'minecraft:grass_block';
    map[3] = 'minecraft:dirt';
    map[4] = 'minecraft:cobblestone';
    map[5] = 'minecraft:oak_planks';
    map[6] = 'minecraft:oak_sapling';
    map[7] = 'minecraft:bedrock';
    map[8] = 'minecraft:water';
    map[9] = 'minecraft:water';
    map[10] = 'minecraft:lava';
    map[11] = 'minecraft:lava';
    map[12] = 'minecraft:sand';
    map[13] = 'minecraft:gravel';
    map[14] = 'minecraft:gold_ore';
    map[15] = 'minecraft:iron_ore';
    map[16] = 'minecraft:coal_ore';
    map[17] = 'minecraft:oak_log';
    map[18] = 'minecraft:oak_leaves';
    map[20] = 'minecraft:glass';
    map[21] = 'minecraft:lapis_ore';
    map[22] = 'minecraft:lapis_block';
    map[24] = 'minecraft:sandstone';
    map[35] = 'minecraft:white_wool';
    map[41] = 'minecraft:gold_block';
    map[42] = 'minecraft:iron_block';
    map[43] = 'minecraft:stone_slab';
    map[44] = 'minecraft:stone_slab';
    map[45] = 'minecraft:bricks';
    map[46] = 'minecraft:tnt';
    map[47] = 'minecraft:bookshelf';
    map[48] = 'minecraft:mossy_cobblestone';
    map[49] = 'minecraft:obsidian';
    map[50] = 'minecraft:torch';
    map[51] = 'minecraft:fire';
    map[52] = 'minecraft:spawner';
    map[53] = 'minecraft:oak_stairs';
    map[54] = 'minecraft:chest';
    map[56] = 'minecraft:diamond_ore';
    map[57] = 'minecraft:diamond_block';
    map[58] = 'minecraft:crafting_table';
    map[59] = 'minecraft:wheat';
    map[60] = 'minecraft:farmland';
    map[61] = 'minecraft:furnace';
    map[64] = 'minecraft:oak_door';
    map[65] = 'minecraft:ladder';
    map[67] = 'minecraft:cobblestone_stairs';
    map[71] = 'minecraft:iron_door';
    map[73] = 'minecraft:redstone_ore';
    map[78] = 'minecraft:snow';
    map[79] = 'minecraft:ice';
    map[80] = 'minecraft:snow_block';
    map[81] = 'minecraft:cactus';
    map[82] = 'minecraft:clay';
    map[85] = 'minecraft:oak_fence';
    map[89] = 'minecraft:glowstone';
    map[95] = 'minecraft:white_stained_glass';
    map[98] = 'minecraft:stone_bricks';
    map[102] = 'minecraft:glass_pane';
    map[103] = 'minecraft:melon';
    map[126] = 'minecraft:oak_slab';
    
    // Add more mappings as needed...
    return map;
}