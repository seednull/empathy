#include <empathy.h>
#include <vector>
#include <cassert>

enum class AtomType: uint32_t
{
	YIELD,
	LINE,
};

enum class YieldCommand: uint32_t
{
	ENUM_MIN = 0,
	TEST = ENUM_MIN,

	ENUM_MAX,
};

struct WorldState
{
	uint32_t day;
	float time;
};

struct LocalState
{
	uint32_t health;
};

uint64_t cmdTest(uint32_t arg0, float arg1)
{
	return static_cast<uint64_t>(arg0 * arg1);
}

void testMachine(Empathy_Instance instance)
{
	Empathy_AtomTypeDesc atom_types[] =
	{
		{(uint32_t)AtomType::YIELD, (uint32_t)YieldCommand::ENUM_MIN, (uint32_t)YieldCommand::ENUM_MAX},
		{(uint32_t)AtomType::LINE, 0, UINT32_MAX},
	};

	Empathy_ParameterDesc world_parameters[] =
	{
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ, offsetof(WorldState, day)},
		{1, {EMPATHY_VALUE_BASE_TYPE_FLOAT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ_WRITE, offsetof(WorldState, time)},
	};

	Empathy_ParameterDesc local_parameters[] =
	{
		{0, {EMPATHY_VALUE_BASE_TYPE_UINT32, 0}, EMPATHY_PARAMETER_ACCESS_FLAGS_READ, offsetof(LocalState, health)},
	};

	Empathy_ParameterTableDesc tables[]
	{
		{0, 2, world_parameters},
		{1, 1, local_parameters},
	};

	Empathy_ValueType yield_test_signature[] =
	{
		{EMPATHY_VALUE_BASE_TYPE_UINT64, 0},
		{EMPATHY_VALUE_BASE_TYPE_FLOAT32, 0},
	};

	Empathy_YieldDesc yields[] =
	{
		{{0,0}, 2, yield_test_signature},
	};

	Empathy_ProgramLayoutDesc layout_desc =
	{
		2, atom_types,
		2, tables,
		1, yields,
	};

	Empathy_ProgramLayout layout = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgramLayout(instance, &layout_desc, &layout);
	assert(result == EMPATHY_SUCCESS);

	std::vector<uint8_t> payload;
	payload.resize(128);

	Empathy_ProgramDesc program_desc =
	{
		layout,
		payload.data(),
		payload.size(),
	};

	Empathy_Program program = EMPATHY_NULL_HANDLE;
	result = empathyCreateProgram(instance, &program_desc, &program);
	assert(result == EMPATHY_SUCCESS);

	Empathy_MachineDesc machine_desc =
	{
		32,
		32,
		8
	};

	Empathy_Machine machine = EMPATHY_NULL_HANDLE;
	result = empathyCreateMachine(instance, &machine_desc, &machine);
	assert(result == EMPATHY_SUCCESS);


	result = empathyDestroyMachine(instance, machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgram(instance, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgramLayout(instance, layout);
	assert(result == EMPATHY_SUCCESS);
}

int main()
{
	Empathy_Instance instance = EMPATHY_NULL_HANDLE;

	Empathy_InstanceDesc instance_desc =
	{
	};

	Empathy_Result result = empathyCreateInstance(&instance_desc, &instance);
	assert(result == EMPATHY_SUCCESS);

	testMachine(instance);

	result = empathyDestroyInstance(instance);
	assert(result == EMPATHY_SUCCESS);

	return 0;
}
