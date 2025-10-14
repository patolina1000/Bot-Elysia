ALTER TABLE downsells
  ADD COLUMN button_intro_text text;

UPDATE downsells
   SET button_intro_text = 'Clique abaixo para continuar:'
 WHERE button_intro_text IS NULL;
