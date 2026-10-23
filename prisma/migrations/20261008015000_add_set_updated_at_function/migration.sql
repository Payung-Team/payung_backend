-- Several catalog migrations create updated_at triggers and assume this
-- shared trigger function already exists. Formalize it for fresh databases;
-- CREATE OR REPLACE is safe for environments where it was created manually.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$function$;
