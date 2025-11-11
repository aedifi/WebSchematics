import * as THREE from './lib/three.js';
import { OrbitControls } from './lib/orbitcontrols.js'
import loadModel from "./models.js";

// Statistics API - emits events that can be intercepted
function emitStats(eventType, data) {
    const event = new CustomEvent('webschematics:stats', {
        detail: {
            type: eventType,
            data: data,
            timestamp: performance.now()
        }
    });
    window.dispatchEvent(event);
}

export default async function render(blocks, width, height, length, parent, resources) {
	const startTime = Date.now();
    
    // Get parent dimensions - handle both div and body cases
    const getParentSize = () => {
        const parentWidth = parent.clientWidth || window.innerWidth;
        const parentHeight = parent.clientHeight || window.innerHeight;
        return { width: parentWidth, height: parentHeight };
    };
    
    let { width: parentWidth, height: parentHeight } = getParentSize();
    
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, parentWidth / parentHeight, 0.1, 1000);

    const renderer = new THREE.WebGLRenderer({ alpha: true });
    renderer.setSize(parentWidth, parentHeight);
    parent.appendChild(renderer.domElement);

    // Make canvas responsive
    const canvas = renderer.domElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';

    // Handle window resize
    const handleResize = () => {
        const newSize = getParentSize();
        parentWidth = newSize.width;
        parentHeight = newSize.height;
        
        camera.aspect = parentWidth / parentHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(parentWidth, parentHeight);
        
        emitStats('resize', {
            width: parentWidth,
            height: parentHeight
        });
    };

    window.addEventListener('resize', handleResize);
    
    // Also handle parent element resize if it's a div (using ResizeObserver)
    if (parent !== document.body && typeof ResizeObserver !== 'undefined') {
        const resizeObserver = new ResizeObserver(() => {
            handleResize();
        });
        resizeObserver.observe(parent);
    }

    emitStats('render:start', {
        dimensions: { width, height, length },
        blockCount: blocks.flat(2).filter(b => b && b.name !== 'minecraft:air').length
    });

    // Step 1: Collect all unique block types and their positions
    const blockMap = new Map(); // key: blockKey, value: { blockName, properties, positions: [] }
    const skippedBlocks = {};
    const blockGrid = new Map(); // For face culling: key: "x,y,z", value: block
    
    console.log('Collecting block data...');
    for (let y = 0; y < blocks.length; y++) {
        for (let x = 0; x < blocks[y].length; x++) {
            for (let z = 0; z < blocks[y][x].length; z++) {
                const block = blocks[y][x][z];
                const id = block.name;
                if (id === "minecraft:air") {
                    continue;
                }

                // Get the blockName by removing the namespace
                let blockName = id.substring(id.indexOf(":") + 1);

                // Check for waxed state blocks
                if (blockName.startsWith("waxed_")) {
                    blockName = blockName.substring(6);
                }

                // Create a key for this block type (including properties for rotation)
                const properties = block.properties || [];
                const blockKey = `${blockName}_${JSON.stringify(properties)}`;
                
                if (!blockMap.has(blockKey)) {
                    blockMap.set(blockKey, {
                        blockName: blockName,
                        properties: properties,
                        positions: []
                    });
                }
                
                blockMap.get(blockKey).positions.push({ x, y, z });
                blockGrid.set(`${x},${y},${z}`, block);
            }
        }
    }

    emitStats('blocks:collected', {
        uniqueBlockTypes: blockMap.size,
        totalBlocks: Array.from(blockMap.values()).reduce((sum, b) => sum + b.positions.length, 0)
    });

    console.log(`Found ${blockMap.size} unique block types, loading models in parallel...`);

    // Step 2: Load all unique block models in parallel (much faster than sequential)
    const modelPromises = [];
    const blockKeys = Array.from(blockMap.keys());
    
    for (const blockKey of blockKeys) {
        const blockData = blockMap.get(blockKey);
        const blockForModel = {
            name: 'block/' + blockData.blockName,
            properties: blockData.properties
        };
        
        modelPromises.push(
            loadModel(blockForModel, resources).then(model => {
                return { blockKey, model };
            }).catch(error => {
                console.warn(`Failed to load model for ${blockData.blockName}:`, error);
                if (!skippedBlocks[blockData.blockName]) skippedBlocks[blockData.blockName] = 0;
                skippedBlocks[blockData.blockName]++;
                return { blockKey, model: null };
            })
        );
    }

    // Wait for all models to load in parallel
    const loadedModels = await Promise.all(modelPromises);
    const modelCache = new Map();
    loadedModels.forEach(({ blockKey, model }) => {
        if (model !== null) {
            modelCache.set(blockKey, model);
        }
    });

    emitStats('models:loaded', {
        loaded: modelCache.size,
        failed: blockKeys.length - modelCache.size,
        skippedBlocks: skippedBlocks
    });

    console.log(`Loaded ${modelCache.size} models, creating meshes...`);

    // Step 3: Create meshes efficiently with progressive rendering
    const geometryCache = new Map();
    const materialCache = new Map();
    let meshCount = 0;
    let vertexCount = 0;
    let faceCount = 0;
    
    // Process blocks in chunks for progressive rendering
    const CHUNK_SIZE = 50; // Process 50 block types at a time
    const blockEntries = Array.from(blockMap.entries());
    
    for (let i = 0; i < blockEntries.length; i += CHUNK_SIZE) {
        const chunk = blockEntries.slice(i, i + CHUNK_SIZE);
        
        for (const [blockKey, blockData] of chunk) {
            const model = modelCache.get(blockKey);
            if (!model) continue;

            const positions = blockData.positions;
            if (positions.length === 0) continue;

            // Check if this block type has rotations or special properties
            const hasRotation = blockData.properties.some(p => 
                p.startsWith("facing=") || p.startsWith("axis=") || p.startsWith("half=") || p.startsWith("type=")
            );

            // Get or create cached geometry and materials
            let cachedGeo = geometryCache.get(blockKey);
            let cachedMat = materialCache.get(blockKey);
            
            if (!cachedGeo || !cachedMat) {
                // Extract geometry and materials from the model
                const extracted = extractGeometryAndMaterials(model);
                cachedGeo = extracted.geometry;
                cachedMat = extracted.materials;
                
                if (cachedGeo && cachedMat) {
                    geometryCache.set(blockKey, cachedGeo);
                    materialCache.set(blockKey, cachedMat);
                } else {
                    continue; // Skip if we can't extract geometry
                }
            }

            if (hasRotation || positions.length < 5) {
                // For rotated blocks or small counts, create individual meshes
                // But reuse the geometry and materials
                positions.forEach(({ x, y, z }) => {
                    const mesh = new THREE.Mesh(cachedGeo.clone(), cachedMat);
                    applyTransformations(mesh, x, y, z, blockData.properties);
                    scene.add(mesh);
                    meshCount++;
                    
                    // Count vertices and faces
                    if (mesh.geometry.attributes.position) {
                        vertexCount += mesh.geometry.attributes.position.count;
                        faceCount += mesh.geometry.attributes.position.count / 3;
                    }
                });
            } else {
                // For blocks without rotation, merge geometries for better performance
                const meshes = [];
                positions.forEach(({ x, y, z }) => {
                    const clonedGeo = translateGeometry(cachedGeo.clone(), x, y, z);
                    meshes.push(new THREE.Mesh(clonedGeo, cachedMat));
                });
                
                // Try to merge geometries
                const merged = mergeGeometries(meshes);
                if (merged) {
                    scene.add(merged);
                    meshCount += positions.length;
                    
                    // Count vertices and faces
                    if (merged.geometry.attributes.position) {
                        vertexCount += merged.geometry.attributes.position.count;
                        faceCount += merged.geometry.attributes.position.count / 3;
                    }
                } else {
                    // Fallback: add individually
                    meshes.forEach(mesh => {
                        scene.add(mesh);
                        if (mesh.geometry.attributes.position) {
                            vertexCount += mesh.geometry.attributes.position.count;
                            faceCount += mesh.geometry.attributes.position.count / 3;
                        }
                    });
                    meshCount += meshes.length;
                }
            }
        }
        
        // Emit progress stats
        emitStats('render:progress', {
            processed: Math.min(i + CHUNK_SIZE, blockEntries.length),
            total: blockEntries.length,
            meshes: meshCount,
            vertices: vertexCount,
            faces: Math.floor(faceCount)
        });
        
        // Yield to browser for smooth rendering
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    emitStats('render:complete', {
        meshes: meshCount,
        vertices: vertexCount,
        faces: Math.floor(faceCount),
        uniqueBlockTypes: blockMap.size
    });

    console.log(`Created ${meshCount} meshes`);

    // Step 4: Setup camera and controls
    const controls = new OrbitControls(camera, renderer.domElement);
    camera.position.set(width / 2, height + (height / 3), length + 10);
    controls.target.set(width / 2, height / 2, length / 2);
    controls.autoRotate = true;
    controls.update();

    // Add a grid at the bottom of the scene
    const gridSize = Math.max(width, length);
    const gridHelper = new THREE.GridHelper(gridSize, gridSize);
    gridHelper.position.set((width / 2) - 0.5, -0.5, (length / 2) - 0.5);
    scene.add(gridHelper);

    // Step 5: Start animation loop with FPS tracking
    let frameCount = 0;
    let lastTime = performance.now();
    let fps = 0;
    
    function animate() {
        requestAnimationFrame(animate);
        
        // Calculate FPS
        frameCount++;
        const currentTime = performance.now();
        if (currentTime >= lastTime + 1000) {
            fps = Math.round((frameCount * 1000) / (currentTime - lastTime));
            frameCount = 0;
            lastTime = currentTime;
            
            // Emit FPS stats
            emitStats('fps', {
                fps: fps,
                meshes: meshCount,
                vertices: vertexCount,
                faces: Math.floor(faceCount)
            });
        }
        
        controls.update();
        renderer.render(scene, camera);
    }

    animate();
    
    const renderTime = (Date.now() - startTime) / 1000;
    
    emitStats('render:finished', {
        totalTime: renderTime,
        meshes: meshCount,
        vertices: vertexCount,
        faces: Math.floor(faceCount),
        uniqueBlockTypes: blockMap.size,
        skippedBlocks: skippedBlocks
    });
    
    console.log("Rendered!", "\n- Unique block types:", blockMap.size, "\n- Total meshes:", meshCount, "\n- Skipped blocks:", skippedBlocks, "\n- Time:", renderTime.toFixed(2), "s");
    
    // Return cleanup function
    return () => {
        window.removeEventListener('resize', handleResize);
        renderer.dispose();
        scene.clear();
    };
}

// Extract geometry and materials from a model group
function extractGeometryAndMaterials(model) {
    const geometries = [];
    const materials = [];
    
    model.traverse((child) => {
        if (child instanceof THREE.Mesh) {
            if (child.geometry) {
                geometries.push(child.geometry);
            }
            if (child.material) {
                if (Array.isArray(child.material)) {
                    materials.push(...child.material);
                } else {
                    materials.push(child.material);
                }
            }
        }
    });
    
    if (geometries.length === 0) {
        return { geometry: null, materials: null };
    }
    
    // Merge all geometries into one
    let mergedGeometry = geometries[0];
    if (geometries.length > 1) {
        // Clone and merge
        for (let i = 1; i < geometries.length; i++) {
            const geo = geometries[i].clone();
            // Translate to account for mesh position
            const mesh = model.children.find(c => c.geometry === geometries[i]);
            if (mesh) {
                const translated = translateGeometry(geo, mesh.position.x, mesh.position.y, mesh.position.z);
                mergedGeometry = mergeTwoGeometries(mergedGeometry, translated);
            } else {
                mergedGeometry = mergeTwoGeometries(mergedGeometry, geo);
            }
        }
    }
    
    // Use first material (or create multi-material if needed)
    const material = materials.length > 0 ? materials[0] : new THREE.MeshBasicMaterial({ color: 0xffffff });
    
    return { geometry: mergedGeometry, materials: material };
}

// Merge two geometries
function mergeTwoGeometries(geo1, geo2) {
    try {
        // Simple approach: create a new geometry with combined attributes
        const merged = new THREE.BufferGeometry();
        
        const pos1 = geo1.attributes.position;
        const pos2 = geo2.attributes.position;
        const norm1 = geo1.attributes.normal;
        const norm2 = geo2.attributes.normal;
        const uv1 = geo1.attributes.uv;
        const uv2 = geo2.attributes.uv;
        
        const positions = [];
        const normals = [];
        const uvs = [];
        
        // Add geometry 1
        if (pos1) {
            for (let i = 0; i < pos1.count; i++) {
                positions.push(pos1.getX(i), pos1.getY(i), pos1.getZ(i));
            }
        }
        if (norm1) {
            for (let i = 0; i < norm1.count; i++) {
                normals.push(norm1.getX(i), norm1.getY(i), norm1.getZ(i));
            }
        }
        if (uv1) {
            for (let i = 0; i < uv1.count; i++) {
                uvs.push(uv1.getX(i), uv1.getY(i));
            }
        }
        
        // Add geometry 2
        if (pos2) {
            for (let i = 0; i < pos2.count; i++) {
                positions.push(pos2.getX(i), pos2.getY(i), pos2.getZ(i));
            }
        }
        if (norm2) {
            for (let i = 0; i < norm2.count; i++) {
                normals.push(norm2.getX(i), norm2.getY(i), norm2.getZ(i));
            }
        }
        if (uv2) {
            for (let i = 0; i < uv2.count; i++) {
                uvs.push(uv2.getX(i), uv2.getY(i));
            }
        }
        
        merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        if (normals.length > 0) {
            merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        }
        if (uvs.length > 0) {
            merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        }
        
        // Merge indices if they exist
        if (geo1.index && geo2.index) {
            const indices = [];
            const offset = pos1 ? pos1.count : 0;
            
            // Add indices from geo1
            for (let i = 0; i < geo1.index.count; i++) {
                indices.push(geo1.index.getX(i));
            }
            
            // Add indices from geo2 with offset
            for (let i = 0; i < geo2.index.count; i++) {
                indices.push(geo2.index.getX(i) + offset);
            }
            
            merged.setIndex(indices);
        } else if (geo1.index) {
            merged.setIndex(geo1.index);
        } else if (geo2.index) {
            const offset = pos1 ? pos1.count : 0;
            const indices = [];
            for (let i = 0; i < geo2.index.count; i++) {
                indices.push(geo2.index.getX(i) + offset);
            }
            merged.setIndex(indices);
        }
        
        return merged;
    } catch (error) {
        console.warn('Failed to merge geometries:', error);
        return geo1; // Return first geometry as fallback
    }
}

// Translate a BufferGeometry
function translateGeometry(geometry, x, y, z) {
    const pos = geometry.attributes.position;
    if (!pos) return geometry;
    
    const positions = [];
    for (let i = 0; i < pos.count; i++) {
        positions.push(
            pos.getX(i) + x,
            pos.getY(i) + y,
            pos.getZ(i) + z
        );
    }
    
    const newGeo = geometry.clone();
    newGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return newGeo;
}

// Merge multiple meshes into one
function mergeGeometries(meshes) {
    if (meshes.length === 0) return null;
    if (meshes.length === 1) {
        const mesh = meshes[0];
        const geo = translateGeometry(mesh.geometry.clone(), mesh.position.x, mesh.position.y, mesh.position.z);
        return new THREE.Mesh(geo, mesh.material);
    }
    
    try {
        let merged = translateGeometry(
            meshes[0].geometry.clone(),
            meshes[0].position.x,
            meshes[0].position.y,
            meshes[0].position.z
        );
        
        for (let i = 1; i < meshes.length; i++) {
            const geo = translateGeometry(
                meshes[i].geometry.clone(),
                meshes[i].position.x,
                meshes[i].position.y,
                meshes[i].position.z
            );
            merged = mergeTwoGeometries(merged, geo);
        }
        
        const material = meshes[0].material;
        return new THREE.Mesh(merged, material);
    } catch (error) {
        console.warn('Failed to merge meshes:', error);
        return null;
    }
}

// Apply transformations based on block properties
function applyTransformations(mesh, x, y, z, properties) {
    mesh.position.set(x, y, z);
    
    if (!properties || properties.length === 0) return;
    
    // Get if upside down
    const half = properties.find(property => property.startsWith("half="));
    const upsideDown = half && half.substring(5) === "top";
    if (upsideDown) {
        mesh.rotation.x = Math.PI;
    }

    // Get facing property
    const facing = properties.find(property => property.startsWith("facing="));
    if (facing) {
        const direction = facing.substring(7);
        switch (direction) {
            case "north":
                mesh.rotation.y += upsideDown ? -Math.PI / 2 : Math.PI / 2;
                break;
            case "east":
                mesh.rotation.y += 0;
                break;
            case "south":
                mesh.rotation.y += upsideDown ? Math.PI / 2 : -Math.PI / 2;
                break;
            case "west":
                mesh.rotation.y += upsideDown ? -Math.PI : Math.PI;
                break;
        }
    }

    // Get type property
    const type = properties.find(property => property.startsWith("type="));
    if (type) {
        const typeValue = type.substring(5);
        if (typeValue === "top") {
            mesh.position.y += 0.5;
        }
    }

    // Get axis property
    const axis = properties.find(property => property.startsWith("axis="));
    if (axis) {
        const direction = axis.substring(5);
        switch (direction) {
            case "x":
                mesh.rotation.z = Math.PI / 2;
                break;
            case "y":
                mesh.rotation.y = 0;
                break;
            case "z":
                mesh.rotation.x = Math.PI / 2;
                break;
        }
    }
}
