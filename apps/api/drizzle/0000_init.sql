CREATE TABLE "comments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "comments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"image_id" integer NOT NULL,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comments_author_name_valid" CHECK (char_length("comments"."author_name") BETWEEN 1 AND 60 AND "comments"."author_name" !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND "comments"."author_name" !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
	CONSTRAINT "comments_body_valid" CHECK (char_length("comments"."body") BETWEEN 1 AND 1000 AND "comments"."body" !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND "comments"."body" !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]')
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "images_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"object_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"author_name" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "images_object_key_key" UNIQUE("object_key"),
	CONSTRAINT "images_object_key_format" CHECK ("images"."object_key" ~ '^images/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpg|png|webp|gif)$'),
	CONSTRAINT "images_mime_type_allowed" CHECK ("images"."mime_type" IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif')),
	CONSTRAINT "images_object_key_matches_mime" CHECK (substring("images"."object_key" from '\.([a-z]+)$') = CASE "images"."mime_type" WHEN 'image/jpeg' THEN 'jpg' WHEN 'image/png' THEN 'png' WHEN 'image/webp' THEN 'webp' WHEN 'image/gif' THEN 'gif' END),
	CONSTRAINT "images_dimensions_positive" CHECK ("images"."width" > 0 AND "images"."height" > 0),
	CONSTRAINT "images_size_positive" CHECK ("images"."size_bytes" > 0),
	CONSTRAINT "images_author_name_valid" CHECK (char_length("images"."author_name") BETWEEN 1 AND 60 AND "images"."author_name" !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND "images"."author_name" !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
	CONSTRAINT "images_title_valid" CHECK (char_length("images"."title") BETWEEN 1 AND 120 AND "images"."title" !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND "images"."title" !~ '[\u0001-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]'),
	CONSTRAINT "images_description_valid" CHECK (char_length("images"."description") BETWEEN 0 AND 2000 AND "images"."description" !~ '^[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]|[\u0009-\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]$' AND "images"."description" !~ '[\u0001-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]')
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE restrict;--> statement-breakpoint
CREATE INDEX "comments_image_id_created_at_id_idx" ON "comments" USING btree ("image_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "images_created_at_id_idx" ON "images" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);