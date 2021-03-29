import { fabric } from 'fabric';
import { Database } from 'sqlite3';

import { loadImage } from './Utilities';
import { pickRandomItem } from '../Utilities';

import {
    selectQuery,
    executeQuery,
} from '../Database';

import {
    AvatarComponent,
    ImageType,
} from './Types';

export const bodies = [
    'body1.png',
];

export const faces = [
    't_boomer.png',
    't_cry.png',
    't_derp.png',
    't_gun.png',
    't_intrigue.png',
    't_jooooe_biden.png',
    't_kissy.png',
    't_lmao.png',
    't_mad.png',
    't_mono.png',
    't_nervous.png',
    't_ooh.png',
    't_sad.png',
    't_salute.png',
    't_scared.png',
    't_shrug.png',
    't_smile.png',
    't_sweat.png',
    't_think.png',
    't_xD.png',
    't_yawn.png',
];

export async function randomTurtle(canvas: fabric.StaticCanvas) {
    const body = pickRandomItem(bodies);
    const face = pickRandomItem(faces);

    const avatar = [
        {
            filepath: pickRandomItem(bodies),
            zIndex: 0,
            imageType: ImageType.Body,
        },
        {
            filepath: pickRandomItem(faces),
            zIndex: 1,
            imageType: ImageType.Face,
        },
    ];

    await specificTurtle(canvas, avatar);
}

export async function specificTurtle(
    canvas: fabric.StaticCanvas,
    avatar: AvatarComponent[],
) {

    const body = avatar.find((x) => x.imageType === ImageType.Body);

    if (!body) {
        avatar.push({
            zIndex: 0,
            filepath: 'body1.png',
            imageType: ImageType.Body,
        });
    }

    const sortedItems = avatar.sort((a: AvatarComponent, b: AvatarComponent) => a.zIndex - b.zIndex); 

    let loadedBody = undefined;
    const images = [];

    for (const item of sortedItems) {
        let folderPath = 'bodies';

        if (item.imageType === ImageType.Face) {
            folderPath = 'faces';
        }

        const image = loadImage(`${folderPath}/10%/${item.filepath}`);

        images.push(image);

        if (item.imageType === ImageType.Body) {
            loadedBody = image;
        }
    }

    const loadedImages = await Promise.all(images);

    const { width, height } = await loadedBody as fabric.Image;

    canvas.setWidth(width!);
    canvas.setHeight(height!);

    for (const image of loadedImages) {
        canvas.add(image);
    }
}

export function generateAvatar(): AvatarComponent[] {
    const body = pickRandomItem(bodies);
    const face = pickRandomItem(faces);

    return [
        {
            filepath: body,
            zIndex: 0,
            imageType: ImageType.Body,
        },
        {
            filepath: face,
            zIndex: 1,
            imageType: ImageType.Face,
        },
    ];
}

export async function loadAvatar(userId: string, db: Database): Promise<AvatarComponent[]> {
    let images = await selectQuery(
        `SELECT
            filepath,
            z_index as zIndex,
            image_type as imageType
        FROM
            turtle_avatars
        WHERE
            user_id = ?
        ORDER BY
            z_index ASC`,
        db,
        [
            userId,
        ],
    );

    if (images.length === 0) {
        images = generateAvatar();
        await saveAvatar(images, userId, db);
    }

    return images;
}

export async function saveAvatar(images: AvatarComponent[], userId: string, db: Database) {
    await executeQuery(
        `DELETE FROM turtle_avatars
        WHERE user_id = ?`,
        db,
        [
            userId,
        ],
    );
    for (const image of images) {
        await executeQuery(
            `INSERT INTO turtle_avatars (
                user_id,
                filepath,
                z_index,
                image_type
            ) VALUES (
                ?,
                ?,
                ?,
                ?
            )`,
            db,
            [
                userId,
                image.filepath,
                image.zIndex,
                image.imageType,
            ],
        );
    }
}
