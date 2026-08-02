#include "impl_internal.h"

#include <assert.h>
#include <string.h>
#include <stdlib.h>

/*
 */
static void impl_destroyProgramLayout(Impl_Instance *instance_ptr, Impl_ProgramLayout *program_layout_ptr)
{
	assert(instance_ptr);
	assert(program_layout_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(program_layout_ptr->parameters);
	free(program_layout_ptr->commands);
	free(program_layout_ptr->command_argument_types);
};

static void impl_destroyProgram(Impl_Instance *instance_ptr, Impl_Program *program_ptr)
{
	assert(instance_ptr);
	assert(program_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(program_ptr->data);
}

static void impl_destroyMachine(Impl_Instance *instance_ptr, Impl_Machine *machine_ptr)
{
	assert(instance_ptr);
	assert(machine_ptr);

	EMPATHY_UNUSED(instance_ptr);

	free(machine_ptr->execution_stack.data);
	free(machine_ptr->predicate_stack.data);
	free(machine_ptr->bindings);
}

/*
 */
static Empathy_Result impl_instanceCreateProgramLayout(Empathy_Instance this, const Empathy_ProgramLayoutDesc *desc, Empathy_ProgramLayout *layout)
{
	assert(this);
	assert(desc);
	assert(layout);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;

	Impl_ProgramLayout result = {0};

	if (desc->num_commands > 0)
	{
		assert(desc->commands);

		uint64_t num_arguments = 0;
		for (uint64_t i = 0; i < desc->num_commands; ++i)
		{
			const Empathy_CommandDesc *command = &desc->commands[i];
			num_arguments += command->num_arguments;
		}

		result.num_commands = desc->num_commands;
		result.commands = (Impl_ProgramLayoutCommand *)malloc(sizeof(Impl_ProgramLayoutCommand) * desc->num_commands);

		result.command_argument_types = (Empathy_ValueType *)malloc(sizeof(Empathy_ValueType) * num_arguments);

		uint64_t current_argument = 0;
		for (uint64_t i = 0; i < desc->num_commands; ++i)
		{
			const Empathy_CommandDesc *src_command = &desc->commands[i];
			Impl_ProgramLayoutCommand *dst_command = &result.commands[i];

			dst_command->index = src_command->index;
			dst_command->result_type = src_command->result_type;
			dst_command->num_arguments = src_command->num_arguments;
			dst_command->base_argument = current_argument;

			for (uint64_t j = 0; j < src_command->num_arguments; ++j)
				result.command_argument_types[current_argument++] = src_command->argument_types[j];
		}
	}

	if (desc->num_tables > 0)
	{
		assert(desc->tables);

		uint64_t num_parameters = 0;
		for (uint64_t i = 0; i < desc->num_tables; ++i)
		{
			const Empathy_ParameterTableDesc *table = &desc->tables[i];
			assert(table);
			assert(table->num_parameters > 0);

			num_parameters += table->num_parameters;
		}

		result.num_parameters = num_parameters;
		result.parameters = (Impl_ProgramLayoutParameter *)malloc(sizeof(Impl_ProgramLayoutParameter) * num_parameters);

		uint64_t current_parameter = 0;
		for (uint64_t i = 0; i < desc->num_tables; ++i)
		{
			const Empathy_ParameterTableDesc *table = &desc->tables[i];
			assert(table);
			assert(table->num_parameters > 0);

			for (uint64_t j = 0; j < table->num_parameters; ++j)
			{
				const Empathy_ParameterDesc *src_parameter = &table->parameters[j];
				Impl_ProgramLayoutParameter *dst_parameter = &result.parameters[current_parameter++];

				dst_parameter->index = src_parameter->index;
				dst_parameter->binding = table->binding;
				dst_parameter->type = src_parameter->type;
				dst_parameter->access = src_parameter->access;
				dst_parameter->offset = src_parameter->offset;
			}
		}
	}

	*layout = (Empathy_ProgramLayout)empathy_poolAddElement(&instance_ptr->program_layouts, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceCreateProgram(Empathy_Instance this, const Empathy_ProgramDesc *desc, Empathy_Program *program)
{
	assert(this);
	assert(desc);
	assert(desc->data);
	assert(desc->size > 0);
	assert(program);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, (Empathy_PoolHandle)desc->layout);
	assert(program_layout_ptr);

	Impl_Program result = {0};
	result.layout = desc->layout;
	result.size = desc->size;
	result.data = malloc(desc->size);
	memcpy(result.data, desc->data, desc->size);

	// TODO: validate?

	*program = (Empathy_Program)empathy_poolAddElement(&instance_ptr->programs, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceCreateMachine(Empathy_Instance this, const Empathy_MachineDesc *desc, Empathy_Machine *machine)
{
	assert(this);
	assert(desc);
	assert(desc->execution_stack_size > 0);
	assert(desc->predicate_stack_size > 0);
	assert(machine);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;

	Impl_Machine result = {0};
	result.program = EMPATHY_NULL_HANDLE;

	if (desc->max_parameter_tables)
	{
		result.max_bindings = desc->max_parameter_tables;
		result.bindings = (Impl_MachineBinding *)malloc(sizeof(Impl_MachineBinding) * desc->max_parameter_tables);

		for (uint64_t i = 0; i < desc->max_parameter_tables; ++i)
			result.bindings[i].data = NULL;
	}

	result.execution_stack.size = desc->execution_stack_size;
	result.execution_stack.data = (Empathy_Value *)malloc(sizeof(Empathy_Value) * desc->execution_stack_size);

	result.predicate_stack.size = desc->predicate_stack_size;
	result.predicate_stack.data = (Empathy_Value *)malloc(sizeof(Empathy_Value) * desc->predicate_stack_size);

	*machine = (Empathy_Program)empathy_poolAddElement(&instance_ptr->machines, &result);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyProgramLayout(Empathy_Instance this, Empathy_ProgramLayout layout)
{
	assert(this);
	assert(layout);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)layout;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElement(&instance_ptr->program_layouts, handle);
	assert(program_layout_ptr);

	empathy_poolRemoveElement(&instance_ptr->program_layouts, handle);

	impl_destroyProgramLayout(instance_ptr, program_layout_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyProgram(Empathy_Instance this, Empathy_Program program)
{
	assert(this);
	assert(program);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)program;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElement(&instance_ptr->programs, handle);
	assert(program_ptr);
	assert(program_ptr->data);
	assert(program_ptr->size > 0);

	empathy_poolRemoveElement(&instance_ptr->programs, handle);

	impl_destroyProgram(instance_ptr, program_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroyMachine(Empathy_Instance this, Empathy_Machine machine)
{
	assert(this);
	assert(machine);

	Empathy_PoolHandle handle = (Empathy_PoolHandle)machine;
	assert(handle != EMPATHY_POOL_HANDLE_NULL);

	Impl_Instance *instance_ptr = (Impl_Instance *)this;
	Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElement(&instance_ptr->machines, handle);
	assert(machine_ptr);
	assert(machine_ptr->execution_stack.data);
	assert(machine_ptr->execution_stack.size > 0);
	assert(machine_ptr->predicate_stack.data);
	assert(machine_ptr->predicate_stack.size > 0);

	empathy_poolRemoveElement(&instance_ptr->machines, handle);

	impl_destroyMachine(instance_ptr, machine_ptr);
	return EMPATHY_SUCCESS;
}

static Empathy_Result impl_instanceDestroy(Empathy_Instance this)
{
	assert(this);

	Impl_Instance *ptr = (Impl_Instance *)this;

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->machines);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_Machine *machine_ptr = (Impl_Machine *)empathy_poolGetElementByIndex(&ptr->machines, head);
			impl_destroyMachine(ptr, machine_ptr);

			head = empathy_poolGetNextIndex(&ptr->machines, head);
		}

		empathy_poolShutdown(&ptr->machines);
	}

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->programs);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_Program *program_ptr = (Impl_Program *)empathy_poolGetElementByIndex(&ptr->programs, head);
			impl_destroyProgram(ptr, program_ptr);

			head = empathy_poolGetNextIndex(&ptr->programs, head);
		}

		empathy_poolShutdown(&ptr->programs);
	}

	{
		uint32_t head = empathy_poolGetHeadIndex(&ptr->program_layouts);
		while (head != EMPATHY_POOL_HANDLE_NULL)
		{
			Impl_ProgramLayout *program_layout_ptr = (Impl_ProgramLayout *)empathy_poolGetElementByIndex(&ptr->program_layouts, head);
			impl_destroyProgramLayout(ptr, program_layout_ptr);

			head = empathy_poolGetNextIndex(&ptr->program_layouts, head);
		}

		empathy_poolShutdown(&ptr->program_layouts);
	}

	free(ptr);
	return EMPATHY_SUCCESS;
}

/*
 */
static Empathy_InstanceTable instance_vtbl =
{
	impl_instanceCreateProgramLayout,
	impl_instanceCreateProgram,
	impl_instanceCreateMachine,

	impl_instanceDestroyProgramLayout,
	impl_instanceDestroyProgram,
	impl_instanceDestroyMachine,
	impl_instanceDestroy,
};

/*
 */
Empathy_Result impl_createInstance(const Empathy_InstanceDesc *desc, Empathy_Instance *instance)
{
	assert(desc);
	assert(instance);

	EMPATHY_UNUSED(desc);

	Impl_Instance *ptr = (Impl_Instance *)malloc(sizeof(Impl_Instance));
	assert(ptr);

	// vtable
	ptr->vtbl = &instance_vtbl;

	// data

	// pools
	empathy_poolInitialize(&ptr->program_layouts, sizeof(Impl_ProgramLayout), 32);
	empathy_poolInitialize(&ptr->programs, sizeof(Impl_Program), 32);
	empathy_poolInitialize(&ptr->machines, sizeof(Impl_Machine), 32);

	*instance = (Empathy_Instance)ptr;
	return EMPATHY_SUCCESS;
}
