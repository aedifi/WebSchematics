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
                // Convert signed byte to unsigned (0-255)
                let blockId = blocksArray[index];
                if (blockId < 0) {
                    blockId = blockId + 256;
                }
                // Ensure it's in valid range
                blockId = blockId & 0xFF;
                
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
// Complete mapping for Minecraft versions 1.0-1.12 (pre-flattening)
function createLegacyBlockMap() {
    const map = {};
    
    // 0-15: Basic blocks
    map[0] = 'minecraft:air';
    map[1] = 'minecraft:stone';
    map[2] = 'minecraft:grass_block';
    map[3] = 'minecraft:dirt';
    map[4] = 'minecraft:cobblestone';
    map[5] = 'minecraft:oak_planks';
    map[6] = 'minecraft:oak_sapling';
    map[7] = 'minecraft:bedrock';
    map[8] = 'minecraft:water';
    map[9] = 'minecraft:water'; // Still water
    map[10] = 'minecraft:lava';
    map[11] = 'minecraft:lava'; // Still lava
    map[12] = 'minecraft:sand';
    map[13] = 'minecraft:gravel';
    map[14] = 'minecraft:gold_ore';
    map[15] = 'minecraft:iron_ore';
    
    // 16-31: Ores and logs
    map[16] = 'minecraft:coal_ore';
    map[17] = 'minecraft:oak_log';
    map[18] = 'minecraft:oak_leaves';
    map[19] = 'minecraft:sponge';
    map[20] = 'minecraft:glass';
    map[21] = 'minecraft:lapis_ore';
    map[22] = 'minecraft:lapis_block';
    map[23] = 'minecraft:dispenser';
    map[24] = 'minecraft:sandstone';
    map[25] = 'minecraft:note_block';
    map[26] = 'minecraft:red_bed';
    map[27] = 'minecraft:powered_rail';
    map[28] = 'minecraft:detector_rail';
    map[29] = 'minecraft:sticky_piston';
    map[30] = 'minecraft:cobweb';
    map[31] = 'minecraft:grass'; // Tall grass
    
    // 32-47: Plants and decorative
    map[32] = 'minecraft:dead_bush';
    map[33] = 'minecraft:piston';
    map[34] = 'minecraft:piston_head';
    map[35] = 'minecraft:white_wool';
    map[37] = 'minecraft:dandelion';
    map[38] = 'minecraft:poppy';
    map[39] = 'minecraft:brown_mushroom';
    map[40] = 'minecraft:red_mushroom';
    map[41] = 'minecraft:gold_block';
    map[42] = 'minecraft:iron_block';
    
    // 43-63: Slabs, stairs, and building blocks
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
    map[55] = 'minecraft:redstone_wire';
    map[56] = 'minecraft:diamond_ore';
    map[57] = 'minecraft:diamond_block';
    map[58] = 'minecraft:crafting_table';
    map[59] = 'minecraft:wheat';
    map[60] = 'minecraft:farmland';
    map[61] = 'minecraft:furnace';
    map[62] = 'minecraft:furnace'; // Lit furnace
    map[63] = 'minecraft:oak_sign';
    
    // 64-79: Doors and interactive blocks
    map[64] = 'minecraft:oak_door';
    map[65] = 'minecraft:ladder';
    map[66] = 'minecraft:rail';
    map[67] = 'minecraft:cobblestone_stairs';
    map[68] = 'minecraft:oak_wall_sign';
    map[69] = 'minecraft:lever';
    map[70] = 'minecraft:stone_pressure_plate';
    map[71] = 'minecraft:iron_door';
    map[72] = 'minecraft:oak_pressure_plate';
    map[73] = 'minecraft:redstone_ore';
    map[74] = 'minecraft:redstone_ore'; // Lit redstone ore
    map[75] = 'minecraft:redstone_torch';
    map[76] = 'minecraft:redstone_torch'; // Lit redstone torch
    map[77] = 'minecraft:stone_button';
    map[78] = 'minecraft:snow';
    map[79] = 'minecraft:ice';
    
    // 80-95: Natural blocks
    map[80] = 'minecraft:snow_block';
    map[81] = 'minecraft:cactus';
    map[82] = 'minecraft:clay';
    map[83] = 'minecraft:sugar_cane';
    map[84] = 'minecraft:jukebox';
    map[85] = 'minecraft:oak_fence';
    map[86] = 'minecraft:carved_pumpkin';
    map[87] = 'minecraft:netherrack';
    map[88] = 'minecraft:soul_sand';
    map[89] = 'minecraft:glowstone';
    map[90] = 'minecraft:nether_portal';
    map[91] = 'minecraft:jack_o_lantern';
    map[92] = 'minecraft:cake';
    map[93] = 'minecraft:repeater';
    map[94] = 'minecraft:repeater'; // Powered repeater
    map[95] = 'minecraft:white_stained_glass';
    
    // 96-111: Trapdoors and more
    map[96] = 'minecraft:oak_trapdoor';
    map[97] = 'minecraft:infested_stone';
    map[98] = 'minecraft:stone_bricks';
    map[99] = 'minecraft:brown_mushroom_block';
    map[100] = 'minecraft:red_mushroom_block';
    map[101] = 'minecraft:iron_bars';
    map[102] = 'minecraft:glass_pane';
    map[103] = 'minecraft:melon';
    map[104] = 'minecraft:pumpkin_stem';
    map[105] = 'minecraft:melon_stem';
    map[106] = 'minecraft:vine';
    map[107] = 'minecraft:oak_fence_gate';
    map[108] = 'minecraft:brick_stairs';
    map[109] = 'minecraft:stone_brick_stairs';
    map[110] = 'minecraft:mycelium';
    map[111] = 'minecraft:lily_pad';
    
    // 112-127: Nether and end blocks
    map[112] = 'minecraft:nether_bricks';
    map[113] = 'minecraft:nether_brick_fence';
    map[114] = 'minecraft:nether_brick_stairs';
    map[115] = 'minecraft:nether_wart';
    map[116] = 'minecraft:enchanting_table';
    map[117] = 'minecraft:brewing_stand';
    map[118] = 'minecraft:cauldron';
    map[119] = 'minecraft:end_portal';
    map[120] = 'minecraft:end_portal_frame';
    map[121] = 'minecraft:end_stone';
    map[122] = 'minecraft:dragon_egg';
    map[123] = 'minecraft:redstone_lamp';
    map[124] = 'minecraft:redstone_lamp'; // Lit redstone lamp
    map[125] = 'minecraft:oak_slab';
    map[126] = 'minecraft:oak_slab';
    map[127] = 'minecraft:cocoa';
    
    // 128-143: Additional blocks (1.2+)
    map[128] = 'minecraft:sandstone_stairs';
    map[129] = 'minecraft:emerald_ore';
    map[130] = 'minecraft:ender_chest';
    map[131] = 'minecraft:tripwire_hook';
    map[132] = 'minecraft:tripwire';
    map[133] = 'minecraft:emerald_block';
    map[134] = 'minecraft:spruce_stairs';
    map[135] = 'minecraft:birch_stairs';
    map[136] = 'minecraft:jungle_stairs';
    map[137] = 'minecraft:command_block';
    map[138] = 'minecraft:beacon';
    map[139] = 'minecraft:cobblestone_wall';
    map[140] = 'minecraft:flower_pot';
    map[141] = 'minecraft:carrots';
    map[142] = 'minecraft:potatoes';
    map[143] = 'minecraft:oak_button';
    
    // 144-159: More blocks (1.4+)
    map[144] = 'minecraft:skeleton_skull';
    map[145] = 'minecraft:anvil';
    map[146] = 'minecraft:trapped_chest';
    map[147] = 'minecraft:light_weighted_pressure_plate';
    map[148] = 'minecraft:heavy_weighted_pressure_plate';
    map[149] = 'minecraft:comparator';
    map[150] = 'minecraft:comparator'; // Powered comparator
    map[151] = 'minecraft:daylight_detector';
    map[152] = 'minecraft:redstone_block';
    map[153] = 'minecraft:quartz_ore';
    map[154] = 'minecraft:hopper';
    map[155] = 'minecraft:quartz_block';
    map[156] = 'minecraft:quartz_stairs';
    map[157] = 'minecraft:activator_rail';
    map[158] = 'minecraft:dropper';
    map[159] = 'minecraft:white_terracotta';
    
    // 160-175: Stained glass and hardened clay (1.6+)
    map[160] = 'minecraft:white_stained_glass_pane';
    map[161] = 'minecraft:acacia_leaves';
    map[162] = 'minecraft:acacia_log';
    map[163] = 'minecraft:acacia_stairs';
    map[164] = 'minecraft:dark_oak_stairs';
    map[165] = 'minecraft:slime_block';
    map[166] = 'minecraft:barrier';
    map[167] = 'minecraft:iron_trapdoor';
    map[168] = 'minecraft:prismarine';
    map[169] = 'minecraft:sea_lantern';
    map[170] = 'minecraft:hay_block';
    map[171] = 'minecraft:white_carpet';
    map[172] = 'minecraft:terracotta';
    map[173] = 'minecraft:coal_block';
    map[174] = 'minecraft:packed_ice';
    map[175] = 'minecraft:sunflower';
    
    // 176-191: Banners and more (1.8+)
    map[176] = 'minecraft:white_banner';
    map[177] = 'minecraft:white_wall_banner';
    map[178] = 'minecraft:daylight_detector';
    map[179] = 'minecraft:red_sandstone';
    map[180] = 'minecraft:red_sandstone_stairs';
    map[181] = 'minecraft:red_sandstone_slab';
    map[182] = 'minecraft:red_sandstone_slab';
    map[183] = 'minecraft:spruce_fence_gate';
    map[184] = 'minecraft:birch_fence_gate';
    map[185] = 'minecraft:jungle_fence_gate';
    map[186] = 'minecraft:dark_oak_fence_gate';
    map[187] = 'minecraft:acacia_fence_gate';
    map[188] = 'minecraft:spruce_fence';
    map[189] = 'minecraft:birch_fence';
    map[190] = 'minecraft:jungle_fence';
    map[191] = 'minecraft:dark_oak_fence';
    
    // 192-207: More fences and blocks (1.9+)
    map[192] = 'minecraft:acacia_fence';
    map[193] = 'minecraft:spruce_door';
    map[194] = 'minecraft:birch_door';
    map[195] = 'minecraft:jungle_door';
    map[196] = 'minecraft:acacia_door';
    map[197] = 'minecraft:dark_oak_door';
    map[198] = 'minecraft:end_rod';
    map[199] = 'minecraft:chorus_plant';
    map[200] = 'minecraft:chorus_flower';
    map[201] = 'minecraft:purpur_block';
    map[202] = 'minecraft:purpur_pillar';
    map[203] = 'minecraft:purpur_stairs';
    map[204] = 'minecraft:purpur_slab';
    map[205] = 'minecraft:purpur_slab';
    map[206] = 'minecraft:end_stone_bricks';
    map[207] = 'minecraft:beetroots';
    
    // 208-223: More blocks (1.10+)
    map[208] = 'minecraft:grass_path';
    map[209] = 'minecraft:end_gateway';
    map[210] = 'minecraft:repeating_command_block';
    map[211] = 'minecraft:chain_command_block';
    map[212] = 'minecraft:frosted_ice';
    map[213] = 'minecraft:magma_block';
    map[214] = 'minecraft:nether_wart_block';
    map[215] = 'minecraft:red_nether_bricks';
    map[216] = 'minecraft:bone_block';
    map[217] = 'minecraft:structure_void';
    map[218] = 'minecraft:observer';
    map[219] = 'minecraft:white_shulker_box';
    map[220] = 'minecraft:orange_shulker_box';
    map[221] = 'minecraft:magenta_shulker_box';
    map[222] = 'minecraft:light_blue_shulker_box';
    map[223] = 'minecraft:yellow_shulker_box';
    
    // 224-239: Shulker boxes (1.11+)
    map[224] = 'minecraft:lime_shulker_box';
    map[225] = 'minecraft:pink_shulker_box';
    map[226] = 'minecraft:gray_shulker_box';
    map[227] = 'minecraft:light_gray_shulker_box';
    map[228] = 'minecraft:cyan_shulker_box';
    map[229] = 'minecraft:purple_shulker_box';
    map[230] = 'minecraft:blue_shulker_box';
    map[231] = 'minecraft:brown_shulker_box';
    map[232] = 'minecraft:green_shulker_box';
    map[233] = 'minecraft:red_shulker_box';
    map[234] = 'minecraft:black_shulker_box';
    map[235] = 'minecraft:white_glazed_terracotta';
    map[236] = 'minecraft:orange_glazed_terracotta';
    map[237] = 'minecraft:magenta_glazed_terracotta';
    map[238] = 'minecraft:light_blue_glazed_terracotta';
    map[239] = 'minecraft:yellow_glazed_terracotta';
    
    // 240-255: More glazed terracotta and final blocks (1.12+)
    map[240] = 'minecraft:lime_glazed_terracotta';
    map[241] = 'minecraft:pink_glazed_terracotta';
    map[242] = 'minecraft:gray_glazed_terracotta';
    map[243] = 'minecraft:light_gray_glazed_terracotta';
    map[244] = 'minecraft:cyan_glazed_terracotta';
    map[245] = 'minecraft:purple_glazed_terracotta';
    map[246] = 'minecraft:blue_glazed_terracotta';
    map[247] = 'minecraft:brown_glazed_terracotta';
    map[248] = 'minecraft:green_glazed_terracotta';
    map[249] = 'minecraft:red_glazed_terracotta';
    map[250] = 'minecraft:black_glazed_terracotta';
    map[251] = 'minecraft:concrete';
    map[252] = 'minecraft:concrete_powder';
    map[253] = 'minecraft:structure_block';
    map[254] = 'minecraft:structure_block';
    map[255] = 'minecraft:air'; // Reserved/unused
    
    return map;
}