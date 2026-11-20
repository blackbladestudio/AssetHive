"""Create a masked sibling of the approved Item master; never alter the opaque master."""
import unreal

SOURCE = '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_VT'
TARGET = '/Game/MaterialLibrary/Character/Common/M_GamePlayItem_Base_Masked_VT'
mel = unreal.MaterialEditingLibrary
eal = unreal.EditorAssetLibrary
material = eal.load_asset(TARGET) if eal.does_asset_exist(TARGET) else None
if material:
    if 'OpacityMasked_VT' not in [str(n) for n in mel.get_texture_parameter_names(material)] or material.get_editor_property('blend_mode') != unreal.BlendMode.BLEND_MASKED:
        raise RuntimeError('Existing masked master needs manual review; it was not overwritten')
else:
    material = eal.duplicate_asset(SOURCE, TARGET)
    if not material:
        raise RuntimeError('Cannot duplicate the approved Item master')
    opacity = mel.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, 1100, 100)
    opacity.set_editor_property('parameter_name', 'OpacityMasked_VT')
    source = eal.load_asset(SOURCE)
    opacity.set_editor_property('texture', mel.get_material_default_texture_parameter_value(source, 'ORM_VT'))
    mask_sampler = next(getattr(unreal.MaterialSamplerType, name) for name in dir(unreal.MaterialSamplerType) if 'VIRTUAL' in name and 'MASK' in name)
    opacity.set_editor_property('sampler_type', mask_sampler)
    if material.get_editor_property('use_material_attributes'):
        output = mel.get_material_property_input_node(material, unreal.MaterialProperty.MP_MATERIAL_ATTRIBUTES)
        output_name = mel.get_material_property_input_node_output_name(material, unreal.MaterialProperty.MP_MATERIAL_ATTRIBUTES)
        if not output:
            raise RuntimeError('Item master has no material attributes output')
        split = mel.create_material_expression(material, unreal.MaterialExpressionBreakMaterialAttributes, 1200, 0)
        attributes = mel.create_material_expression(material, unreal.MaterialExpressionMakeMaterialAttributes, 1600, 0)
        unreal.log('Item original output: ' + output_name + '; break inputs: ' + str(mel.get_material_expression_input_names(split)))
        if not mel.connect_material_expressions(output, output_name, split, ''):
            raise RuntimeError('Cannot preserve Item master material attributes')
        for pin in mel.get_material_expression_input_names(attributes):
            is_mask = pin.replace(' ', '').lower() == 'opacitymask'
            output_pin = pin.replace(' ', '').replace('CustomizedUVs_', 'CustomizedUV')
            if not mel.connect_material_expressions(opacity if is_mask else split, 'R' if is_mask else output_pin, attributes, pin):
                raise RuntimeError('Cannot preserve material attribute: ' + pin)
        mel.connect_material_property(attributes, '', unreal.MaterialProperty.MP_MATERIAL_ATTRIBUTES)
    else:
        mel.connect_material_property(opacity, 'R', unreal.MaterialProperty.MP_OPACITY_MASK)
    material.set_editor_property('blend_mode', unreal.BlendMode.BLEND_MASKED)
    mel.recompile_material(material)
    if not eal.save_loaded_asset(material):
        raise RuntimeError('Cannot save masked Item master')
unreal.log('AssetHive masked Item master ready: ' + TARGET)
