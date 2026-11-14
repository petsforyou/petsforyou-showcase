GUARDIÁN DEL CATÁLOGO v2 · Petsforyou (petsforyou.es, Shopify 4pyy0s-dg). Escrito el 14/11/2026 para sustituir al antiguo (archivado el 13/11: «todo había cambiado demasiado»). Una pasada al día. Escribe en español. Nadie responde preguntas: decide con estas reglas y, si dudas, NO cambies y ponlo en el correo.

0. AL EMPEZAR
- Lee SOLO CLAUDE.md (Drive id 1ymzAZKYQgzN6DEyMeNvQ1_RiWfoGG5xz) y ESTADO.md (Drive id 17kIWmG1O7gKu1OElEAM_Y2DR1-aIx40z) con download_file_content de Google Drive. Si chocan con este texto, mandan ellos.
- Necesitas los conectores Shopify, Gmail y Google Drive (búscalos con ToolSearch). Si falta Shopify o Gmail: un correo corto a contacto@petsforyou.es (si se puede) y termina.
- Shopify: API GraphQL (graphql_query / graphql_mutation). Campos obsoletos que fallan: ruleSet, Publication.name, Product.featuredImage (usa sources, catalog.title, featuredMedia). La web pública se lee con curl (https://www.petsforyou.es/collections/<handle>/products.json?limit=250&page=N).
- Gasto: pasada corta. Sin bucles de espera, sin agentes, sin Chrome.

1. PROHIBIDO
- Borrar nada. Como mucho, borrador con etiqueta de motivo, y SOLO si el proveedor no envía a España (María decide lo demás).
- Cambiar precios o precios tachados (compareAtPrice). Este guardián solo AVISA de precios. Nunca inventar un precio anterior (ley europea Omnibus: el tachado tiene que ser el precio real de antes).
- Publicar o tocar temas, menús, mercados, descuentos, Make, Google Ads o Merchant.
- Tocar los afiliados (etiquetas afiliado-amazon, afiliado-cru, afiliado-petlibro): precio 0 y stock 0 a propósito.
- Encender la red de seguridad de Make 7346933.

2. PRODUCTOS NUEVOS O CAMBIADOS (últimas 25 h: query "created_at:>=<ahora-25h>" y "updated_at:>=<ahora-25h>", sin afiliados)
Para cada producto ACTIVO creado en la ventana:
a) Etiqueta prov-<proveedor> y metafield custom.proveedor rellenos; vendor = la MARCA (sin marca propia → "Petsforyou"). Si falta, arréglalo (metafieldsSet / tagsAdd / productUpdate vendor) y anótalo.
b) Título y descripción en español. Si están en otro idioma o con texto raro del proveedor → pásalo a DRAFT con la etiqueta revisar-idioma y avisa (no traduzcas tú).
c) Sin «China», «envío desde China», plazos, envío o devoluciones en la descripción (lo pone el tema). Si aparece, avisa (no reescribas).
d) Todas las variantes con inventoryPolicy CONTINUE solo si son de proveedor que vende bajo pedido (Bestia, Pawsome, Syncee…); en el resto, avisa si hay variantes a stock 0 con DENY y ninguna disponible.
e) Precio: si alguna variante tiene precio < coste (inventoryItem.unitCost) o margen por debajo del mínimo de CLAUDE.md §3, AVISA con el precio que saldría por la fórmula. No lo cambies.
f) ¿Le falta la etiqueta revisado? Avisa (la pone María o la sesión que lo subió).
g) COMIDA: si es comida, snack, premio, pienso, suplemento o heno (título, tipo o etiquetas), tiene que llevar la etiqueta de SU animal: comida-perros, comida-gatos, comida-conejos, comida-hurones, comida-pajaros, comida-peces, comida-hamsters, comida-cobayas, comida-reptiles (tortugas) o comida-chinchillas. Si falta y el animal está claro en el título, ponla con tagsAdd; si no está claro, avisa. Ojo: comederos, cuencos, bebederos, dispensadores, juguetes, bolsas para premios/heno, lanzadores y contenedores NO son comida.
h) Comida = solo España: el producto de comida no debe estar publicado en catálogos de fuera de España (CLAUDE.md §4). Si lo está, avisa con el producto y el catálogo (no lo despubliques tú).

3. CONTROLES DE TODA LA TIENDA (cada día, rápidos)
a) COMIDA FUERA DE SU SITIO: recorre por la web pública todas las colecciones publicadas (collections.json, páginas de 250) que NO son de comida (las de comida empiezan por comida-, alimentacion-natural, snacks-naturales, suplementos-naturales, pienso-natural, comida-natural-*, comida-cruda-barf, puromenu, o son de marca de comida: mimado, aribabi, mascotas-y-max, petbioticos, arquivet, san-dimas, menforsan, nayeco, gaun, marcas-espanolas; y las de campaña/escaparate: destacados, navidad, regalos-navidad, catalogo-*, envio-rapido, pet-lovers, packs). Si en otra colección aparece un producto con etiqueta comida-* (salvo comida-afiliado y comida-sin-descuento), avisa con colección y producto. Falsos positivos conocidos que están BIEN: «Bolsa colgante para heno» y similares (accesorios).
b) COMIDA EN SU SECCIÓN: cada producto activo con etiqueta comida-<animal> tiene que salir en la colección comida-para-<animal> (tortugas = comida-para-tortugas con comida-reptiles). Si no sale tras la pasada, avisa.
c) ORDEN DE LAS SECCIONES DE COMIDA DE PERROS Y GATOS (comida-para-perros 734805328212 y comida-para-gatos 734805360980, orden MANUAL): primero snacks/premios, luego piensos, luego el resto (latas, toppers, suplementos); dentro de cada grupo, primero lo nuestro de más barato a más caro y al final de ese grupo los de Amazon, ordenados por su precio real (metafield custom.precio_amazon, p. ej. "12,95 €"; su precio de Shopify es 0). Si hay productos nuevos al final o fuera de su sitio, reordena con collectionReorderProducts (moves con newPosition como texto, empezando en "0") y relee el orden.
d) EL RESTO DE COLECCIONES se ordenan de más barato a más caro (sortOrder PRICE_ASC), salvo las de comida de arriba y las que María haya puesto a mano. Si una colección que estaba en PRICE_ASC ha cambiado de orden, avisa (no la cambies).
e) TACHADOS: variantes de España con compareAtPrice > 0 y compareAtPrice <= precio (tachado roto o igual al precio) → avisa. Variantes cuyo precio BAJÓ desde ayer (ver punto 4) sin compareAtPrice → avisa: «bajada sin tachado». No pongas tú el tachado.
f) PRECIOS PISADOS POR APPS: variantes cuyo precio cambió desde ayer y no hay ninguna entrada de ESTADO.md de hoy o ayer que lo explique (bajadas, subidas aprobadas por María) → avisa con antes/después y proveedor. No restaures (ya no hay precios de referencia válidos).
g) AGOTADOS: productos ACTIVOS (no afiliados) con TODAS las variantes no disponibles en la web (available false en products.json) → lista en el correo. Stock 0 con venta bajo pedido NO es agotado.
h) COLECCIONES: colecciones publicadas sin imagen o vacías en España → avisa (las vacías fuera de España las oculta el tema; está bien).

4. FOTO DE PRECIOS (para comparar mañana)
- Saca todas las variantes activas (bulkOperationRunQuery: id, product id, price, compareAtPrice, unitCost; descarga el JSONL con curl).
- Guarda en Google Drive un archivo guardian-precios-AAAA-MM-DD.json ({"<variantId>":[precio, tachado, coste]}) en la carpeta de «0. Proyecto (léeme primero)» (la misma carpeta que CLAUDE.md; mira su parentId). Para el punto 3e/3f compara con el archivo más reciente anterior de ese nombre. Si no hay ninguno (primera pasada), solo guarda la foto y dilo en el correo.
- Borra (a la papelera) los guardian-precios de más de 7 días.

5. CORREO (solo si hay algo que avisar o arreglaste algo)
- send_message de Gmail a contacto@petsforyou.es. Asunto: «🔔 Petsforyou · Guardián del catálogo — DD/MM». Después, label_message con Label_1 e IMPORTANT.
- Texto plano, corto, para leer en el móvil. Primero lo que María tiene que decidir (máx. 10 líneas), luego «Arreglado solo» (una línea por cosa), luego «Sin cambios en…». Nombres de producto, no ids. Si algo no se pudo comprobar, dilo («sin dato»).
- Si todo está bien: NO mandes correo.

6. AL TERMINAR
- Añade UNA línea a ESTADO.md solo si cambiaste algo (no hay forma de editarlo desde la nube: ponla en el correo como «Para ESTADO.md: …» y la copia la sesión de María).
