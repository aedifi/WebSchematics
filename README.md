# WebSchematics

WebSchematics lets you render Minecraft schematic files in the web, completely in the browser. It uses `nbt.js` to parse the schematic and converts block models from a resource pack into `three.js` meshes, before assembling them into a scene.

Credit to William278 for creating this project.

![Demo screenshot](images/demo-screenshot.png)

Still a work in progress, but it looks pretty neat! Check out the [live demo](https://aedifi.github.io/WebSchematics/)—though note it only currently works with modern Sponge v3 (`.schem`) schematics, like the ones you can generate with WorldEdit.

## License
WebSchematics is licensed under Apache-2.0. It uses the following libraries:
* [three.js](https://github.com/mrdoob/three.js/), released under MIT
* [lodash](https://github.com/lodash/lodash), released under MIT
* [pako.js](https://github.com/nodeca/pako), released under MIT
* [nbt.js](https://github.com/sjmulder/nbt-js), released under the public domain

Minecraft textures and models are &copy; Mojang A.B. and are not included in the source. You'll need to provide your own resource pack or fetch them remotely.
